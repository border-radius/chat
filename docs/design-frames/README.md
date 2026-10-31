# Design frames

The boards of the 2026-10-31 redesign (DESIGN.md §7.1, §7.8; ANDROID.md §36), kept here as the reference the web app
and the Android app were restyled from. Copied from the "Chirkle Sidebar Redesign" Design canvas on claude.ai.

Each board is a `.dc.html` file: static HTML with inline styles, plus small `<sc-for>`/`<sc-if>` templates and a
`DCLogic` script that fill in the repeated rows. They need the Design canvas runtime (`support.js`, not included) to
render as drawn; opened directly in a browser they show the fixed parts only. `canvas.json` is the canvas layout:
where each board sits and its title. The frames load Inter from Google Fonts; the app itself serves its own copy
(`web/fonts/`).

Boards prefixed `X` cover screens that already existed and were redrawn in the new look; `Android` ones are the
app; `F` ones are `Main` opened at one state (a dialog, a menu, a page).

| Board | Title | Size |
|---|---|---|
| [`Main.dc.html`](Main.dc.html) | App · new sidebar & chat | 1440×900 |
| [`States.dc.html`](States.dc.html) | Sidebar states & collapsed rail | 760×900 |
| [`Archive.dc.html`](Archive.dc.html) | Sections collapsed · hidden & archived open | 280×900 |
| [`Composer.dc.html`](Composer.dc.html) | Composer states | 760×940 |
| [`WebRooms.dc.html`](WebRooms.dc.html) | Mobile web · rooms | 390×844 |
| [`WebChat.dc.html`](WebChat.dc.html) | Mobile web · chat | 390×844 |
| [`AndroidRooms.dc.html`](AndroidRooms.dc.html) | Android · rooms | 412×915 |
| [`AndroidChat.dc.html`](AndroidChat.dc.html) | Android · chat | 412×915 |
| [`AndroidSheet.dc.html`](AndroidSheet.dc.html) | Android · long-press actions | 412×915 |
| [`FRoomMenu.dc.html`](FRoomMenu.dc.html) | Room options menu | 1440×900 |
| [`FAccess.dc.html`](FAccess.dc.html) | Room access | 1440×900 |
| [`FNewRoom.dc.html`](FNewRoom.dc.html) | New room (inline) | 1440×900 |
| [`FProfile.dc.html`](FProfile.dc.html) | Profile & settings | 1440×900 |
| [`FCollection.dc.html`](FCollection.dc.html) | Collection page | 1440×900 |
| [`FViewer.dc.html`](FViewer.dc.html) | Media viewer · save to collection | 1440×900 |
| [`Side.dc.html`](Side.dc.html) | Shared sidebar (used by the boards in this row) | 280×900 |
| [`XEdit.dc.html`](XEdit.dc.html) | Edit & delete your own messages | 1440×900 |
| [`XSelect.dc.html`](XSelect.dc.html) | Selecting messages | 1440×900 |
| [`XForward.dc.html`](XForward.dc.html) | Forward dialog | 1440×900 |
| [`XSearch.dc.html`](XSearch.dc.html) | Search in room | 1440×900 |
| [`XMediaGrid.dc.html`](XMediaGrid.dc.html) | Room media grid | 1440×900 |
| [`XJumpTo.dc.html`](XJumpTo.dc.html) | Jump to (⌘K) | 1440×900 |
| [`XDm.dc.html`](XDm.dc.html) | Direct message & new DM search | 1440×900 |
| [`XGuest.dc.html`](XGuest.dc.html) | Guest reading an Open Air room | 1440×900 |
| [`XLogin.dc.html`](XLogin.dc.html) | Log in / Sign up with invite code | 1440×900 |
| [`XReadOnly.dc.html`](XReadOnly.dc.html) | When the composer is replaced | 760×1000 |
| [`AndroidOwnSheet.dc.html`](AndroidOwnSheet.dc.html) | Android · long-press on your own message | 412×915 |
| [`XCollectionFollow.dc.html`](XCollectionFollow.dc.html) | Collection you follow (not yours) | 1440×900 |
| [`XPicker.dc.html`](XPicker.dc.html) | Attach from a collection | 1440×900 |
| [`XSendStates.dc.html`](XSendStates.dc.html) | Sending, failures & attachments | 1440×900 |
| [`XLight.dc.html`](XLight.dc.html) | Light theme | 1440×900 |
| [`AndroidAccounts.dc.html`](AndroidAccounts.dc.html) | Android · accounts | 412×915 |
| [`AndroidServerLogin.dc.html`](AndroidServerLogin.dc.html) | Android · log in on a server | 412×915 |
