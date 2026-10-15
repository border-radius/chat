# Chat for Android

The Android app for Chat: React Native with Expo (SDK 57), the same features as the web app, for any Chat server.
Anyone can host a server and there is no directory of them, so the app starts by asking for one's address (e.g.
`chat.example.com`, or a pasted link to one of its rooms). It checks the address is a Chat server, then keeps it in
your list with its title and logo. Add as many as you like and switch between them; each keeps its own login, drafts
and cached rooms.

## What it shares with the web app

The app doesn't reimplement the client. It imports the web client's API layer, state and room logic from
`../web/src` (see [`src/shared.ts`](src/shared.ts)):
- `api.ts` and `pb.ts`, including the realtime protocol
- the store, sync, unread counts and prefetching
- the room controller: windowed history, optimistic sending, reconnect gap-fill, edits, deletes, reactions
- drafts, site settings, and the pure `lib/` helpers

The same server code serves both apps, with the same rules, limits and wording. The app only adds what a phone needs:

| File | Why |
|---|---|
| `src/core/sse.ts` | EventSource over React Native's streaming XHR (PocketBase realtime is Server-Sent Events). Restarted when the app comes back from the background, since Android drops sockets there |
| `src/core/client.ts` | Uploads of picked files (`{ uri, name, type }`, not Blobs) as multipart with progress; everything else is the web client |
| `src/core/kv.ts` | A synchronous `Storage` over AsyncStorage, for drafts, the site cache and recent emoji |
| `src/core/servers.ts`, `urls.ts` | Server list, address rules, the probe, and one session per server in secure storage |
| `src/core/session.ts` | The web's `app.ts` without the DOM: session renewal, revocation, switching users, background/foreground |
| `src/core/files.ts` | Gallery, camera and file pickers; images scaled to 2048 px and re-encoded (which drops EXIF location), avatars to 512 px |
| `src/app/`, `src/room/`, `src/ui/` | The screens (Expo Router) |

Their unit tests live with the web app's, in `../tests/unit/mobile/`, and run with `npm test` at the repo root. They
include realtime through `NativeEventSource` against a real PocketBase.

## Phone-specific behavior

The app does everything the web app does (rooms, DMs, private and Open Air rooms, replies, reactions, attachments,
the viewer, forwarding, selecting, unread counts, drafts, profile, invite-only signup, guests). On a phone, some of it
works differently:
- Long press a message for its actions: quick reactions, Reply, Forward, Select, Copy text, Edit, Delete, Message
  the author. While selecting, a tap selects.
- Edits happen in the composer (an "Editing message" bar) rather than in the message.
- Attach from the gallery (photos and videos), the camera, or any file. Other files open through the share sheet
  ("Open with…").
- Links to rooms on the same server (`https://server/r/…`) open in the app; other links open in an in-app browser.
- Android's back button stops selecting before it leaves the room.

## Develop

Requires Node ≥ 22. From `mobile/`:

```sh
npm ci
npx expo start            # then press "a" for an Android emulator/device with a development build
npx expo run:android      # build and install a development build locally (Android SDK + JDK 17 needed)
npm run web               # the same app in a browser (react-native-web), handy against a local server
npm run typecheck
```

Run the server with `npm run dev` at the repo root (http://127.0.0.1:8090). From an emulator, the address is
`http://10.0.2.2:8090`; from a phone on the same network, use the computer's LAN address. Plain `http://` is allowed
for servers on your own network, and the server list marks those "not secure".

## Build an APK

In the cloud with EAS (an Expo account; no Android SDK needed):

```sh
npx eas-cli@latest build -p android --profile preview      # an APK to install directly
npx eas-cli@latest build -p android --profile production   # an .aab for Google Play
```

Locally, with JDK 17 and the Android SDK (platform 36, build-tools 36.0.0, NDK 27.1.12297006, CMake 3.22.1):

```sh
npx expo prebuild -p android
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
# → android/app/build/outputs/apk/release/app-release.apk
```

The release build is signed with the debug key (fine for sideloading and testing). For Play, set up a release
keystore, or let EAS manage signing. `android/` is generated (`expo prebuild`) and not committed: configure the app in
`app.json`.
