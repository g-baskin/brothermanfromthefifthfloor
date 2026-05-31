# Brah Mobile

Minimal Expo Android client for the Brah desktop mobile bridge.

## Run on Android

1. Start Brah desktop from the repo root:

   ```bash
   npm start
   ```

2. In Brah desktop, open **Mobile** and click **Start pairing**. Keep the Android phone on the same Wi‑Fi as the Mac.

3. Start the Expo dev server:

   ```bash
   cd mobile/brah-mobile
   npm install
   npm run android
   ```

4. In the Android app, enter the host, port, and 6-digit code shown in Brah desktop.

5. Tap **Pair**, then **Auth**, then **OpenAI** or **Load tools**.

## Notes

- The desktop bridge briefly binds to the Mac LAN IP while pairing, then returns to loopback after a device pairs or pairing is stopped.
- Device credentials are stored in Android secure storage.
- This client is intentionally small: pairing, auth, OpenAI status, tool definitions, and manual tool execution.
