# Brah Mobile

Minimal Expo Android development client for the Brah desktop mobile bridge.

## Recommended Android workflow

Brah Mobile uses a custom Expo development build, not Expo Go. The development build is pinned to this project’s Expo SDK and native modules, so the Play Store Expo Go version does not matter.

1. Start Brah desktop from the repo root:

   ```bash
   npm start
   ```

2. In Brah desktop, open **Mobile** and click **Start pairing**. Keep the Android phone on the same Wi‑Fi as the Mac.

3. Build and install the Android development client once:

   ```bash
   cd mobile/brah-mobile
   npm install
   npm run eas:android
   ```

   Install the APK from the EAS build link on the phone. Open the installed **Brah Mobile** app, not Expo Go.

4. Start Metro for the development client:

   ```bash
   npm start
   ```

5. In the Android app, enter the host, port, and 6-digit code shown in Brah desktop.

6. Tap **Pair**, then **Auth**, then **OpenAI** or **Load tools**.

## Local Android build alternative

If Android Studio, Android SDK Platform Tools, and USB debugging are configured locally, install directly with:

```bash
cd mobile/brah-mobile
npm run android
npm start
```

## Notes

- Realtime conversation voice uses Expo SDK 56 `expo-audio` PCM streaming.
- The desktop bridge briefly binds to the Mac LAN IP while pairing, then returns to loopback after a device pairs or pairing is stopped.
- Device credentials are stored in Android secure storage.
- Expo Go is no longer the target runtime for this app.
