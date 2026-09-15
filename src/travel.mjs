import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { findWindows } from 'windows-iana';
import { z } from 'zod';
import { readJson, writeJson } from './store.mjs';

const text = z.string().trim().min(1);
const date = z.iso.date();
const dates = { startDate: date, endDate: date };
const validRange = value => value.endDate >= value.startDate && (Date.parse(value.endDate) - Date.parse(value.startDate)) / 86400000 < 31;
const rangeMessage = 'End date must be on or after start date; trips are limited to 31 days.';
const itinerarySchema = z.strictObject({
  title: text.max(120), destination: text.max(120), ...dates,
  timeZone: text.max(80).refine(value => findWindows(value).length > 0, 'Use a supported IANA time zone, such as Asia/Singapore.'),
  weather: text.max(1800),
  days: z.array(z.strictObject({ date, plan: text.max(2400) })).min(1).max(31),
  sources: z.array(z.strictObject({ title: text.max(180), url: z.url({ protocol: /^https?$/ }).max(1000) })).min(1).max(12),
}).refine(validRange, rangeMessage).refine(value => {
  const days = value.days.map(day => day.date);
  return new Set(days).size === days.length && days.length === (Date.parse(value.endDate) - Date.parse(value.startDate)) / 86400000 + 1 && days.every(day => day >= value.startDate && day <= value.endDate);
}, 'Include one itinerary day for each trip date, without duplicates.');
const recipientSchema = z.strictObject({ recipient: z.email().max(254) });
const digest = buffer => createHash('sha256').update(buffer).digest('hex');

async function renderPdf(itinerary) {
  const document = new PDFDocument({ size: 'A4', margin: 48, info: { Title: itinerary.title, Author: 'Travel Harness Lab' } });
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    document.on('data', chunk => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
  });
  if (process.platform === 'win32') document.font(path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', 'segoeui.ttf'));
  document.fontSize(10).fillColor('#a52a45').text('TRAVEL HARNESS / ITINERARY');
  document.moveDown().fontSize(24).fillColor('#222222').text(itinerary.title);
  document.moveDown(0.5).fontSize(11).text(`${itinerary.destination} | ${itinerary.startDate} to ${itinerary.endDate}`);
  document.text(`Local time zone: ${itinerary.timeZone}`);
  document.moveDown().fontSize(14).text('Weather and uncertainty');
  document.moveDown(0.4).fontSize(10).text(itinerary.weather);
  for (const day of [...itinerary.days].sort((first, second) => first.date.localeCompare(second.date))) {
    if (document.y > 660) document.addPage();
    document.moveDown().fontSize(14).text(day.date);
    document.moveDown(0.4).fontSize(11).text(day.plan);
  }
  document.moveDown().fontSize(14).text('Sources');
  for (const source of itinerary.sources) {
    document.moveDown(0.5).fontSize(9).fillColor('#222222').text(source.title);
    document.fillColor('#185e9f').text(source.url, { link: source.url });
  }
  document.moveDown().fillColor('#555555').fontSize(9).text('Planning advice only. No reservations or purchases were made. Verify current conditions before travel.');
  document.end();
  return result;
}

export function createTravelTools({ dataDir, runId, connectors, research }) {
  const directory = path.join(dataDir, 'reports');
  const artifact = path.join(directory, `${runId}.itinerary.json`);
  async function loadItinerary() {
    const saved = await readJson(artifact, null);
    if (!saved) throw new Error('Export and approve an itinerary PDF in this run before delivery.');
    const itinerary = itinerarySchema.parse(saved.itinerary);
    const pdf = await readFile(path.join(directory, `${runId}.pdf`));
    if (digest(pdf) !== saved.sha256) throw new Error('The itinerary PDF changed. Delivery is blocked.');
    return { itinerary, pdf, sha256: saved.sha256 };
  }
  const delivery = (kind, description) => ({
    approval: true, description, schema: recipientSchema,
    async prepare({ recipient }) {
      if (!connectors.workiq || connectors.workiq.ready === false) throw new Error('WorkIQ is not connected. Delivery requires a separate authenticated local connector.');
      if (await readJson(path.join(directory, `${runId}.${kind}.json`), null)) throw new Error('This delivery was already attempted. Check Outlook; automatic duplicate sends are blocked.');
      const saved = await loadItinerary();
      return { recipient, itinerary: saved.itinerary, attachment: { file: `${runId}.pdf`, bytes: saved.pdf.length, sha256: saved.sha256 }, action: kind === 'calendar' ? 'Create an all-day trip invitation for all trip dates.' : 'Submit email with the saved itinerary PDF attached.' };
    },
    async execute({ recipient }, { signal, prepared }) {
      signal?.throwIfAborted();
      const saved = await loadItinerary();
      if (saved.sha256 !== prepared.attachment.sha256 || JSON.stringify(saved.itinerary) !== JSON.stringify(prepared.itinerary)) throw new Error('The approved itinerary changed. Delivery is blocked.');
      const receiptFile = path.join(directory, `${runId}.${kind}.json`);
      await writeFile(receiptFile, JSON.stringify({ state: 'attempting', recipient, sha256: saved.sha256, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      const body = `${saved.itinerary.title}\n${saved.itinerary.destination}: ${saved.itinerary.startDate} to ${saved.itinerary.endDate}\nTime zone: ${saved.itinerary.timeZone}\n\n${saved.itinerary.days.map(day => `${day.date}\n${day.plan}`).join('\n\n')}\n\nWeather: ${saved.itinerary.weather}\n\nSources:\n${saved.itinerary.sources.map(source => source.url).join('\n')}`;
      let response;
      if (kind === 'calendar') {
        const exclusiveEnd = new Date(Date.parse(saved.itinerary.endDate) + 86400000).toISOString().slice(0, 10);
        const timeZone = findWindows(saved.itinerary.timeZone)[0];
        response = await connectors.workiq.callTool('create_entity', { parentUrl: '/me/events', jsonBody: {
          subject: saved.itinerary.title, body: { contentType: 'text', content: body }, isAllDay: true,
          start: { dateTime: `${saved.itinerary.startDate}T00:00:00`, timeZone }, end: { dateTime: `${exclusiveEnd}T00:00:00`, timeZone },
          location: { displayName: saved.itinerary.destination }, attendees: [{ emailAddress: { address: recipient }, type: 'required' }],
          transactionId: digest(Buffer.from(`${runId}:calendar`)),
        } }, { signal });
      } else {
        response = await connectors.workiq.callTool('do_action', { actionUrl: '/me/sendMail', jsonBody: {
          Message: { subject: saved.itinerary.title, body: { contentType: 'text', content: body }, toRecipients: [{ emailAddress: { address: recipient } }],
            attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'itinerary.pdf', contentType: 'application/pdf', contentBytes: saved.pdf.toString('base64') }] }, SaveToSentItems: true,
        } }, { signal });
      }
      const status = Number(response?.statusCode || response?.status);
      const confirmed = !response?.isError && (kind === 'calendar' ? Boolean(response?.id || response?.data?.id) : status >= 200 && status < 300);
      await writeJson(receiptFile, { state: confirmed ? 'submitted' : 'unconfirmed', recipient, sha256: saved.sha256, response, at: new Date().toISOString() });
      if (!confirmed) throw new Error('WorkIQ did not return explicit success evidence. Check Outlook; the action may have completed. Do not retry automatically.');
      return { submitted: true, kind, recipient, sha256: saved.sha256, response, notice: 'Submission confirmed, not recipient delivery or acceptance.' };
    },
  });
  return {
    search_weather: {
      description: 'Research weather for exact travel dates via WebIQ. Search results do not automatically verify a forecast. Cite dates and sources; never label seasonal averages as a forecast.',
      schema: z.strictObject({ destination: text.max(120), ...dates }).refine(validRange, rangeMessage),
      async execute({ destination, startDate, endDate }, { signal }) {
        const result = await research(`${destination} weather forecast ${startDate} to ${endDate} official meteorological service`, signal);
        return { ...result, requestedDates: { startDate, endDate }, forecastVerified: false, guidance: 'Check source coverage and issue dates. If no source provides a forecast for these exact dates, say unavailable; seasonal climate guidance must be labeled separately.' };
      },
    },
    export_itinerary_pdf: {
      approval: true, description: 'Export a real itinerary PDF locally after approval. Include one plan per trip date, IANA time zone, weather uncertainty and source URLs. Export once per run, before calendar or email delivery.',
      schema: itinerarySchema,
      async execute(itinerary, { signal }) {
        const pdf = await renderPdf(itinerary);
        if (pdf.length > 2500000) throw new Error('PDF exceeds the 2.5 MB attachment limit.');
        signal?.throwIfAborted();
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, `${runId}.pdf`), pdf, { flag: 'wx', mode: 0o600 });
        const sha256 = digest(pdf);
        await writeJson(artifact, { itinerary, sha256 });
        return { saved: true, file: `${runId}.pdf`, bytes: pdf.length, sha256, download: `/api/runs/${runId}/pdf` };
      },
    },
    create_trip_calendar: delivery('calendar', 'Create an all-day Outlook trip invitation from this run\'s saved itinerary for the user-specified recipient. Separate human approval and a connected WorkIQ service required; never invent a recipient.'),
    send_itinerary_email: delivery('email', 'Email this run\'s saved itinerary PDF to the user-specified recipient through WorkIQ. Separate human approval required. Never invent a recipient or claim recipient delivery from submission evidence.'),
  };
}