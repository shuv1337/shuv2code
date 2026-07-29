# iOS Alpha distribution with Sqim

The first shuv2code Alpha reaches iOS through Sqim before any internal
TestFlight rollout.

1. Set `APP_VARIANT=production` and provide only the Apple/team configuration
   required by the target account.
2. Verify `vp run --filter @shuv2code/mobile config:prod` reports
   `dev.shuv.shuv2code`, the `shuv2code` scheme, and version
   `0.1.0-alpha.1`.
3. Build the production iOS app with the repository's mobile workflow.
4. Upload the signed build to Sqim using the account's approved process.
5. Install it on a representative device, pair it with a local shuv2code
   server, and verify thread creation, agent output, theme selection, and
   reconnect.
6. Record the build identifier and confirmation in the release notes.

The GitHub release workflow requires the operator to confirm the matching Sqim
release before publication. TestFlight remains an explicit later action.
