<h1 align="center">AgentOnBrowser</h1>

<div align="center">

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

</div>

## 🌐 AgentOnBrowser

AgentOnBrowser is an open-source AI agent that works in your own browser. Tell it a task in the side panel; it reads the pages, clicks, types and moves between tabs to get it done, and it asks you before it submits, sends, deletes or uploads anything.

Based on [Nanobrowser](https://github.com/nanobrowser/nanobrowser) (Apache-2.0).

## 🔥 Why AgentOnBrowser?

- **Free.** No subscription and no hidden costs. Use your own API key or a local model, and pay only for what you use.
- **Private.** Everything runs in your browser. Your keys stay in the browser and go only to their own provider. Pages go only to the model you choose. Telemetry is disabled in the build itself: nothing is collected and nothing is sent.
- **Flexible LLM.** Choose from many cloud providers, run a model on your own computer, or connect a local OpenCode V2 agent service. No lock-in.
- **Open source.** All the code is public, so you can see exactly how it works and change it to fit your needs.

## 📊 Key Features

- **Chat in the side panel**: say what you need in plain words. The agent reads pages, clicks, types and moves between tabs to get it done.
- **OpenCode V2 agents**: connect a local OpenCode V2 service as the brain. The service keeps its own model configuration, and the extension attaches its browser tools to the agent's session over client MCP.
- **Permission cards**: when the agent service asks for a permission, the panel shows a card and sends your answer (allow once or deny) back to it.
- **Service status dots**: every configured agent service is polled for its health, and the picker, the composer and the settings page show a breathing dot: online, checking, restricted (auth or origin) or offline.
- **Several tasks at once**: each task works in its own tab group, so you can run a few side by side and keep browsing.
- **You choose when it asks**: pick Ask or Auto mode, and set rules for each site (see below).
- **Your choice of model**: cloud or local. Pick the model, and how hard it thinks, for each chat.
- **Images and files**: attach images, text files or a screenshot of the current tab. The agent can also upload your files to a page.
- **Save results**: the agent can save its work, like a CSV table or a Markdown report, to your Downloads folder. Chrome asks you the first time.
- **Shortcuts**: save a prompt you use often and start it by typing `/`. You can give it a start page and a model.
- **Voice input**: speak instead of typing, with OpenAI's or Gemini's voice model.
- **Memory**: tell the agent what to keep in mind in every chat, like who you are or how you like your answers.
- **Long tasks**: when a chat gets long, older steps are summed up automatically so the task can go on. Your own messages are always kept in full.
- **Chat history**: go back to any chat, edit a message and run it again from there, or export the chat as Markdown.
- **Your language and theme**: English, Simplified Chinese or Traditional Chinese, in light or dark.

## 🌐 Browser Support

- **Supported:** Chrome and Edge.
- **Not supported:** Firefox, Safari, and other Chromium-based browsers (Opera, Arc, Brave and others). AgentOnBrowser may work in them, but they are not tested.

## 🛡️ You decide what the agent may do

| What the agent does | Ask mode (default) | Auto mode |
| --- | --- | --- |
| Read pages, click links, scroll, move between tabs | Goes ahead | Goes ahead |
| Submit, send, delete or upload | Asks you first | Goes ahead |
| Pay, enter a password or code, grant access | Hands the step to you | Hands the step to you |

You can also set a site to **Allow** (go ahead in both modes), **Ask** (ask in both modes) or **Block** (the agent may not use it), in Settings → Permissions.

> [!NOTE]
> **You are always in charge.**
>
> - The agent may not notice every step that needs you. When it does notice one, your settings always apply, and no AI model can change them.
> - The agent reads text on a web page as information, never as orders. This helps against pages that try to trick it (prompt injection), but no protection is perfect.
> - So use sites you trust, keep an eye on the agent, and press **Stop** at any time to take over.

## 🤖 Models

| Kind | Providers |
| --- | --- |
| Cloud | Anthropic, OpenAI, Google Gemini, AWS Bedrock, OpenRouter, xAI Grok, DeepSeek, Mistral, and any OpenAI-compatible endpoint |
| Local | Ollama and LM Studio, and other servers (llama.cpp, vLLM and others) through the OpenAI-compatible provider |
| Agent service | OpenCode V2 (a local service that brings its own model) |

- **A model must support tool calling.** Test models in Settings checks each model and marks the ones that cannot be used.
- **Choose the model and the reasoning effort** in the panel, per conversation. Settings holds the defaults.
- **Vision models** can also take screenshots of the page and read the images you attach.
- **Local models** work best for simple, clear tasks. Give them a context window of 16k tokens or more. Ollama needs `OLLAMA_ORIGINS` to allow the extension, and LM Studio needs CORS on; the provider card shows how when a request is refused.
- **Voice input** uses OpenAI's or Gemini's voice model with your key from that provider.

## 💡 Try these

> "Summarize this page in a few bullet points."

> "Compare the three laptops I have open and put the prices and specs in a table."

> "Find a portable Bluetooth speaker on Amazon that is water-resistant, under $50, with at least 10 hours of battery."

> "Extract the top 10 headlines from TechCrunch in the last 24 hours and save them as a CSV file."

## 🚀 Install and Set Up

AgentOnBrowser is built from source and loaded unpacked:

1. **Build it** (needs [Node.js](https://nodejs.org/) 24 LTS and [pnpm](https://pnpm.io/installation) 10):

   ```bash
   git clone https://github.com/holny/agent-on-browser.git
   cd agent-on-browser
   corepack enable # skip if pnpm 10 is already installed
   pnpm install
   pnpm build      # builds the extension into dist/
   ```

2. **Load it in Chrome or Edge:**
   - Open `chrome://extensions` (in Edge, `edge://extensions`).
   - Turn on `Developer mode` (top right).
   - Click `Load unpacked` and choose the `dist` folder.

3. **Set it up:** the welcome page opens and helps you connect a cloud provider, a local model, or an OpenCode V2 agent service. You can also do it later in Settings → Providers and Settings → Agent.

4. **Use it:** click the AgentOnBrowser icon in the toolbar, or press `Alt+Shift+N`, to open the side panel on the current tab. To update, pull the latest source, run `pnpm build` again, and click the reload icon on the AgentOnBrowser card in the extensions page.

## 🔌 Connect an OpenCode V2 Agent

Instead of configuring a model provider, you can let a running [OpenCode](https://github.com/nanobrowser/nanobrowser) V2 service (or your own build of it) answer the runs:

1. **Start the service** on your machine, and make sure its origin list allows this extension's origin (`chrome://extensions` → AgentOnBrowser → ID). The service rejects WebSocket connections from origins it does not know.
2. **Add the agent**: Settings → Agent → Add, then fill in the service address (for example `http://127.0.0.1:49377`), the password if the service asks for one, and an existing project directory.
3. **Test the connection**, then pick the agent in the panel. The dot next to its name shows the service's live status.
4. **Run a task**: the extension attaches its browser tools to the service's session, and when the service asks for a permission, a card in the panel sends your answer back to it.

## 🛠️ Development

```bash
pnpm dev               # run in development mode, reloads on changes; load dist/ in Chrome
pnpm zip               # make a release build as a zip file in dist-zip/
pnpm type-check        # check types
pnpm lint              # check code style and import rules
pnpm test              # run the unit tests
pnpm install-chrome    # install Chrome for Testing, used by the browser tests
pnpm autorun scenarios # run the browser tests on local test pages, without a window
```

**How it works.** The agent sits on top of a **browser control layer**. The layer looks at the page, acts on it, and reports what happened. It has no AI model in it, so the same input always gives the same result. This makes the agent more reliable:

- **It clicks the right element.** Each element the agent sees gets an ID that is tied to that exact element. If the page changes, an old ID stops working instead of pointing at something else.
- **It acts like a real user.** Clicks and typing are real browser input. Before acting, the layer checks that the element is visible, not moving, enabled, and not covered by something else.
- **It tells the agent what really happened.** Each action is sent only once. The result says whether it went through, whether the page responded, and whether the page reached the expected state.

The layer talks to the page only through Chrome's `chrome.debugger` API, and uses Puppeteer to keep track of frames on the page. For developers there is a test panel to try the layer by hand: bind a key to the `open-test-panel` command in `chrome://extensions/shortcuts`.

[AGENTS.md](AGENTS.md) (also `CLAUDE.md`) explains the design rules, how the repository is laid out and how we work, for people and for AI coding assistants.

## 🤝 Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; it also says which files a pull request may not change.

## 🔒 Security

If you find a security vulnerability, please **do not** disclose it in public issues, pull requests or discussions. Report it through a [GitHub Security Advisory](https://github.com/holny/agent-on-browser/security/advisories/new), so it can be fixed before it is made public. See [SECURITY.md](SECURITY.md).

## 👏 Acknowledgments

AgentOnBrowser is based on [Nanobrowser](https://github.com/nanobrowser/nanobrowser) and builds on other great open-source projects:

- [Nanobrowser](https://github.com/nanobrowser/nanobrowser)
- [Puppeteer](https://github.com/puppeteer/puppeteer)
- [Vercel AI SDK](https://github.com/vercel/ai)
- [WXT](https://wxt.dev)
- [Browser Use](https://github.com/browser-use/browser-use)

Thanks to their creators and contributors.

## 📄 License

AgentOnBrowser is licensed under the Apache License 2.0. See the [LICENSE](LICENSE) file for details.
