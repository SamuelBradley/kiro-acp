# Kiro ACP - Copilot Chat

Use Kiro CLI's models in GitHub Copilot Chat. The extension starts `kiro-cli acp --agent-engine=v3 --auth-method=cli` in the background and sends chat messages to it through the Agent Client Protocol (ACP). Kiro does the reasoning. VS Code runs the tools.

This extension utilises copilots tools and as best as it can tries to use kiro via ACP as a simple proxy to access kiro's models within the copilot harness. It works in both the "local" and "copilot" harnesses.

## Requirements

- VS Code 1.105 or later, with GitHub Copilot Chat
- Kiro CLI 2.35 or later, installed so that `kiro-cli` runs from a terminal (2.35.1 is the version this was tested with)
- A Kiro CLI login. Run `kiro-cli login` once before you use the extension.

## Install

Install the `.vsix` file from the Extensions view (the **...** menu, then **Install from VSIX...**), or run:

```
code --install-extension kiro-acp-<version>.vsix
```

When the extension starts, it writes an agent profile to `~/.kiro/agents/vscode-tools.json`. Kiro lists that profile as a global agent.

## Use

1. In Copilot Chat, open the model picker and select the **Manage Language Models** gear icon. You can also run **Chat: Manage Language Models** from the Command Palette.
2. Find **Kiro ACP** in the list of providers, then turn on the models you want to see in the picker.
3. Select a Kiro model in the picker and send your message.

- After logging in to Kiro CLI, run **Kiro ACP: Refresh Kiro Models** from the Command Palette to detect your available models. If you weren't already logged in at startup. 
- Models that support reasoning effort show a **Thinking Effort** setting in the picker.
- Kiro uses the tools that VS Code provides to chat, such as file reads, edits, search and terminal commands. VS Code runs each tool call in the chat, so its normal confirmations and progress appear.
- Kiro's own write and shell tools are turned off for these chats. Kiro can still use one read-only file tool that it always offers.
- If Kiro asks permission to run a tool that is not one of the VS Code tools, VS Code shows a pick list of Kiro's options. Dismissing the list declines the request.
- A status bar item shows Kiro's context usage. Its tooltip shows the credits the last turn cost.

## Limitations

- The chat's context indicator does not show Kiro's usage. VS Code gives language model providers no way to report it (microsoft/vscode#330783), so the status bar item shows it instead.
- A follow-up message continues the Kiro session that answered the earlier messages. The extension finds that session by comparing digests of the chat's user messages, so message text and image data are not stored. Kiro keeps its own memory of the conversation. If an earlier message changes, for example after you edit it, the follow-up starts a new session, and the earlier messages and images are sent again.
- Kiro sessions that sit idle for 30 minutes are closed to free memory. The next message reopens them from Kiro's saved history. Chats also keep working after VS Code restarts, as long as their earlier messages are unchanged. The extension keeps the 50 most recent chats.
- Steering, which means changing an answer while Kiro is still writing it, is not supported. The language model API gives the extension no way to add a message to a running answer.
- Images are sent to every Kiro model. MiniMax M2.5 and Qwen3 Coder Next cannot read images, so they say so in their answers.
- Kiro works in the first folder of your workspace. With no folder open, it uses your home folder.

## Troubleshooting

- **No Kiro models in the picker:** check that `kiro-cli` runs in a terminal and that `kiro-cli login` succeeds, then run **Kiro ACP: Refresh Kiro Models** from the Command Palette.
- **"Kiro did not switch to the vscode-tools agent":** run **Kiro ACP: Regenerate Kiro Agent Profile** from the Command Palette to rewrite the profile at `~/.kiro/agents/vscode-tools.json`.
- **Errors during a chat:** open the Output panel, select **Kiro ACP** from the list, and read the messages.

The extension has no settings. It always starts `kiro-cli` from your PATH.

## Development

```
npm install
npm run build     # typecheck and bundle to dist/extension.js
npm run check     # self-checks that do not need kiro-cli
npm run smoke     # end-to-end test against your kiro-cli login, which uses a few credits
npm run package   # build kiro-acp-<version>.vsix
```

## License

MIT. See [LICENSE](LICENSE).
