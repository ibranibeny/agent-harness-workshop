# Agent Harness Workshop

A local Windows / Node.js 24 travel-planning lab with real Microsoft Foundry inference, bounded tool execution, optional Sequential Thinking MCP, conversation continuity and exact human approval before writes.

**Start with the [published workshop](https://ibranibeny.github.io/agent-harness-workshop/).** Read the [L400 engineering guide](https://ibranibeny.github.io/agent-harness-workshop/l400.html) and download the [editable three-page draw.io architecture](https://ibranibeny.github.io/agent-harness-workshop/harness.drawio).

## Quick Start

Prerequisites: Windows, Node.js 24+, Git, Azure Developer CLI (`azd`), and access to an existing compatible Foundry model deployment. Travel research also requires separately authorized WebIQ MCP access. This is not a general public WebIQ entitlement.

```powershell
Set-Location $env:LOCALAPPDATA
git clone https://github.com/ibranibeny/agent-harness-workshop.git
Set-Location agent-harness-workshop
npm.cmd ci --ignore-scripts
Copy-Item .env.example .env
notepad.exe .env
azd auth login --tenant-id YOUR-TENANT-GUID
npm.cmd run doctor
npm.cmd test
npm.cmd start
```

Enter your tenant, permitted sign-in account, commercial Azure OpenAI endpoint, deployment name and actual RPM/TPM limits in `.env`. Never commit credentials or user MCP configuration. Open the loopback URL printed by the server, normally `http://127.0.0.1:4317`.

`npm.cmd run test:live` makes billable inference calls. The deterministic suite does not prove live inference or connector access. Runtime data defaults to `%LOCALAPPDATA%\AgentHarnessWorkshop`, outside the repository. A separate server needs a separate `HARNESS_DATA_DIR`.

## Safety And Scope

- Real inference and actual MCP observations only; no production simulator fallback.
- Planning is optional; simple research can call WebIQ directly.
- Each PDF, memory or report write requires an exact approval preview and human decision.
- WorkIQ production writes are not implemented. No email or calendar success is claimed.
- GitHub Pages serves static teaching material only. It cannot host the local Node backend.
- The landing-zone diagram is a reference design, not deployed infrastructure.
- No Azure resources, roles or quota changes are performed by this repository.
- Loopback single-user educational tool, not a production multi-user service.

## Source And Tests

`src/harness.mjs` owns the model/tool loop; `src/tools.mjs` owns validation and approval; `src/connectors.mjs` owns MCP transport; `src/store.mjs` owns persistence and history reconstruction. The [workshop Markdown](docs/WORKSHOP.md) and [L400 Markdown](docs/L400.md) explain the contracts and failure modes.

The `data/documents` files are explicitly fictional inputs for a legacy arithmetic/report exercise. They are not Azure retail prices or travel research. See the evidence section of the published guide for the exact tested source revision and screenshot scope.