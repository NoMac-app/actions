# NoMac Actions

Sign an iOS app and send it to TestFlight from a [NoMac CI](https://nomac.app/docs/ci) job (`runs-on: nomac`), with no Apple secret stored in GitHub. NoMac keeps the App Store Connect key and makes the profiles; the job's Mac gets only NoMac's CI certificate and the profiles of the bundle IDs you allowed, for that job.

```yaml
permissions:
  id-token: write
  contents: read
jobs:
  release:
    runs-on: nomac
    steps:
      - uses: actions/checkout@v5
      - uses: NoMac-app/actions/sign@v1
      - run: |
          xcodebuild archive -scheme App -configuration Release -destination 'generic/platform=iOS' -archivePath build/App.xcarchive -xcconfig "$NOMAC_XCCONFIG" ${NOMAC_BUILD_NUMBER:+CURRENT_PROJECT_VERSION=$NOMAC_BUILD_NUMBER}
          xcodebuild -exportArchive -archivePath build/App.xcarchive -exportPath build/export -exportOptionsPlist "$NOMAC_EXPORT_OPTIONS"
      - uses: NoMac-app/actions/testflight@v1
        with:
          ipa: build/export/App.ipa
```

Before the first run, on [nomac.app/dash/ci](https://nomac.app/dash/ci) (Signing from jobs):

1. Connect your Apple account on the Apple page, and make the **CI certificate** (one of your team's distribution certificates, with a key of its own).
2. **Allow the workflow**: the repository, the workflow file (`.github/workflows/release.yml`), the bundle IDs it may sign, and whether tags sign too.

Only that workflow file signs, on the repository's default branch (and its tags, if you allowed them), and only on a NoMac Mac. A pull request, another branch or a fork never does. Every step of an allowed job can read the keychain, so allow only workflows you trust: if a key ever leaks, revoke the CI certificate at Apple and your NoMac Macs keep signing with their own.

## sign

| Input | | Output and variable |
| --- | --- | --- |
| `path` | the project's folder (`.`) | `xcconfig`, `NOMAC_XCCONFIG` |
| `scheme` | when there are several | `export-options`, `NOMAC_EXPORT_OPTIONS` |
| `container` | the `.xcodeproj` or `.xcworkspace`, when there are several | `team-id`, `NOMAC_TEAM_ID`; `build-number`, `NOMAC_BUILD_NUMBER` |

## testflight

| Input | |
| --- | --- |
| `ipa` | the signed `.ipa` |
| `notes` | What to Test |
| `wait` | `sent` (Apple has the build; the default) or `testflight` |

The app needs its App Store Connect record, and its export compliance answered once (`ITSAppUsesNonExemptEncryption` in its Info.plist, or once from a NoMac Mac).
