# OpenAI Realtime Voice Setup Prompt

Copy/paste this prompt into GG Coder inside the app folder where you want to build the setup.

```text
Build an OpenAI Realtime voice setup like Brah.

The app should work like this:

1. The user clicks “Connect OpenAI”.
2. The Electron main process starts an OpenAI OAuth login using PKCE.
3. OpenAI opens in the browser and the user signs in.
4. OpenAI redirects back to a localhost callback server.
5. The main process exchanges the returned code at https://auth.openai.com/oauth/token.
6. The main process securely stores access_token, refresh_token, and expiry.
7. The renderer must never receive the long-lived access_token or refresh_token.
8. When the user starts a voice call, the renderer asks the main process for a short-lived Realtime client secret.
9. The main process refreshes the OpenAI token if needed.
10. The main process calls POST https://api.openai.com/v1/realtime/client_secrets.
11. The main process sends a Realtime session config with model, voice, instructions, audio input/output settings, tool definitions, and tool_choice: "auto".
12. The renderer receives only the short-lived Realtime client secret.
13. The renderer gets microphone audio with navigator.mediaDevices.getUserMedia().
14. The renderer creates an RTCPeerConnection.
15. The renderer creates a data channel named "oai-events".
16. The renderer adds microphone tracks to the peer connection.
17. The renderer creates an SDP offer.
18. The renderer POSTs the offer.sdp to https://api.openai.com/v1/realtime/calls.
19. That request uses:
    Authorization: Bearer <short-lived-realtime-secret>
    Content-Type: application/sdp
20. The renderer reads OpenAI’s SDP answer.
21. The renderer sets the answer as the remote description.
22. The renderer plays assistant audio in an audio element.
23. The renderer listens for JSON events on the data channel.
24. If OpenAI emits a function/tool call, the renderer executes it through safe Electron IPC.
25. The renderer sends the tool result back with conversation.item.create using item.type: function_call_output.
26. The renderer then sends response.create.

Required files/pieces:
- Main-process OpenAI OAuth login with PKCE.
- Localhost OAuth callback server.
- Token exchange and token refresh.
- Secure encrypted token storage in the Electron main process.
- IPC handlers:
  openai:get-status
  openai:login
  openai:logout
  openai:create-realtime-secret
  tools:get-definitions
  tools:execute
- Preload bridge methods:
  getOpenAIStatus()
  loginOpenAI()
  logoutOpenAI()
  createRealtimeSecret()
  getRealtimeTools()
  executeRealtimeTool(name, args)
- Renderer call start/stop flow.
- WebRTC connection to OpenAI Realtime.
- Data channel event handling.
- Realtime tool-call handling.
- Basic tool definitions and local tool execution.
- Safety checks so long-lived OpenAI credentials never enter the renderer.

Important:
First inspect the codebase.
Then propose a small file-by-file implementation plan.
Do not edit files until I approve the plan.
After I approve, implement it, run the smallest relevant checks, and fix failures before reporting done.
```

## After GG Coder proposes a plan

If the plan looks good, reply:

```text
Approved. Implement the plan. Keep credentials only in the main process, expose only short-lived Realtime secrets to the renderer, and run the smallest relevant checks before reporting done.
```

## Commands to run after implementation

Use the commands that match the app’s package manager and scripts. For a normal npm Electron app, try:

```bash
npm install
npm start
npm run check
npm test
```
