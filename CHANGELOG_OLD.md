# Older changes
## 0.6.1 (2026-05-09)

- (patricknitsch) Add Measurement in DM Info
- (patricknitsch) Update Admin Dependency >= 7.6.23 for Device Manager
- First Important Note: From 0.5.3 to 0.6.X the Sensor Overview is removed but visible. Thats a Bug from js-controller and should be fixed with 7.1.3
- Second Important Note: If you come from 0.5.3 you'll need to re-enter your API key because of removed Encryption. Use from Doc.

## 0.6.0 (2026-05-08)

- (copilot) Integrate Adapter in ioBroker Device Manager
- (copilot) Remove Tab
- (patricknitsch) Removed Encryption and Protection from Api-Key because it's a global key --> fill in ApiKey again after Update

## 0.5.3 (2026-05-03)

- (copilot) Adapter requires node.js >= 22 now
- (copilot) Update Dependencies

## 0.5.2 (2026-03-20)

- (patricknitsch) Update Readme
- (patricknitsch) Fix Issues from RepoChecker

## 0.5.1 (2026-03-18)

- (copilot) Fix issue with configuration button in Tab

## 0.5.0 (2026-03-17)

- (copilot) Add control panel with green theme, i18n (DE/EN), live status banner, quick modes, temperature control, vacation, schedule viewer and configuration button
- (copilot) Status banner now shows energy consumption for today (kWh)
- (copilot) Instance selector removed — instance is auto-detected from the `?instance=N` URL parameter passed by Admin 7

## 0.4.3 (2026-03-06)

- (patricknitsch) Fix adapter type in io-package.json

## 0.4.2 (2026-03-06)

- (claude) Fixed object hirarchy
- (patricknitsch) Update Readme

## 0.4.1 (2026-02-26)

- (patricknitsch) Update Packages and Workflow

## 0.4.0 (2026-02-11)

- (claude) Fallback if Devices or Cloud offline

## 0.3.2 (2026-01-31)

- (patricknitsch) Update from git to https

## 0.3.1 (2026-01-31)

- (patricknitsch) Add Mode Frost Protection
- (patricknitsch) Show Enum instead of Regulation Number

## 0.3.0 (2026-01-31)

- (patricknitsch) Update Readme
- (patricknitsch) Verify Polling if Thermostat give no Response
- (patricknitsch) Complete Refactoring to handle functions better
- (patricknitsch) encrypt all sensitive credentials -> Relogin necessary
- (patricknitsch) Code Fixing for latest repo

## 0.2.4 (2026-01-28)

- (patricknitsch) Change Format of Times

## 0.2.3 (2026-01-28)

- (patricknitsch) Catch wrong values for Temperature and Regulation Mode

## 0.2.2 (2026-01-28)

- (patricknitsch) Update setStates for ComfortMode
- (patricknitsch) More Debugging

## 0.2.1 (2026-01-28)

- (patricknitsch) Fix JsonConfig

## 0.2.0 (2026-01-28)

- (patricknitsch) add automatic Refresh of Token after Error 403
- (patricknitsch) fix max Value of Regulation Mode to 9 for error preventing
- (patricknitsch) improve Handling of Mode Settings

## 0.1.1 (2026-01-28)

- (patricknitsch) updated Readme

## 0.1.0 (2026-01-28)

- (patricknitsch) initial release
- (patricknitsch) fetch data and write in Datapoints
- (patricknitsch) functional version with Energy and settable functions

[Older changelogs can be found there](CHANGELOG_OLD.md)
