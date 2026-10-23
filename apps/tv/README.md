# S2Code Apple TV

A read-only tvOS dashboard for one or more paired servers. It shares `T3WatchKit`
(`packages/watch-native`) with the Watch, so it uses the same `/api/watch/v1`
HTTP API and device-code pairing, and it never submits commands.

```sh
cd apps/tv
xcodegen generate
xcodebuild build -project S2CodeTV.xcodeproj -scheme S2CodeTV \
  -destination 'platform=tvOS Simulator,name=<your Apple TV simulator>' \
  -derivedDataPath build/DD CODE_SIGN_IDENTITY=-
```

Build with signing, even ad hoc, because an unsigned build cannot use the
keychain. In the simulator, launch with `-S2CodeTVPairOrigin http://host:port`
to pair that origin (or add it as another server) without the tvOS keyboard.
Approve the code shown on screen with
`shuv2code pair --watch --approve CODE`.
