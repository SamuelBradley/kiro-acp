# Kiro CLI Models for Copilot Chat

Use Kiro CLI's models in GitHub Copilot Chat. The extension starts `kiro-cli acp --agent-engine=v3 --auth-method=cli` in the background and sends chat messages to it through the Agent Client Protocol (ACP). Kiro does the reasoning. VS Code runs the tools.

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
2. Find **Kiro CLI** in the list of providers, then turn on the models you want to see in the picker.
3. Select a Kiro model in the picker and send your message.

- Models that support reasoning effort show a **Thinking Effort** setting in the picker.
- Kiro uses the tools that VS Code provides to chat, such as file reads, edits, search and terminal commands. VS Code runs each tool call in the chat, so its normal confirmations and progress appear.
- Kiro's own write and shell tools are turned off for these chats. Kiro can still use one read-only file tool that it always offers.
- If Kiro asks permission to run a tool that is not one of the VS Code tools, VS Code shows a pick list of Kiro's options. Dismissing the list declines the request.
- A status bar item shows Kiro's context usage. Its tooltip shows the credits the last turn cost.

## Limitations

- Kiro may send its answer in large chunks rather than word by word. This comes from Kiro's output, not from the extension.
- A tool call waits up to 10 minutes for VS Code to return a result. After that, the turn is cancelled.
- The chat's context indicator does not show Kiro's usage. VS Code gives language model providers no way to report it (microsoft/vscode#330783), so the status bar item shows it instead.
- A follow-up message continues the Kiro session that answered the earlier messages. The extension finds that session by comparing digests of the chat's user messages, so the message text itself is not stored. Kiro keeps its own memory of the conversation. If an earlier message changes, for example after you edit it, the follow-up starts a new session, and the earlier messages are sent again as plain text.
- Kiro sessions that sit idle for 30 minutes are closed to free memory. The next message reopens them from Kiro's saved history. Chats also keep working after VS Code restarts, as long as their earlier messages are unchanged. The extension keeps the 50 most recent chats.
- Steering, which means changing an answer while Kiro is still writing it, is not supported. The language model API gives the extension no way to add a message to a running answer.
- Image input is not supported.
- Kiro works in the first folder of your workspace. With no folder open, it uses your home folder.

## Troubleshooting

- **No Kiro models in the picker:** check that `kiro-cli` runs in a terminal and that `kiro-cli login` succeeds. Then reload the window.
- **"Kiro did not switch to the vscode-tools agent":** the profile at `~/.kiro/agents/vscode-tools.json` is missing or invalid. Reload the window so the extension writes it again.
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
