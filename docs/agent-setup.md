# Small fleet setup with stock Hermes

Keep one VPS primary as the owner of the real Telegram conversation. The Mac
Hermes- Alan's way app is a browser/tool host, not a second Telegram gateway. An
optional native Mac profile can handle deliberately separate local sessions;
it should retain its own transcript and should not poll the primary's bot
token. Add specialists only when there is a clear independent role.

## Workspace behavior

Install the [Alan's Way agent plugin](https://github.com/inteliodev/alans-way-agents)
on the gateway host — its bundled `workspace-operations` skill covers browser
and handoff behavior for this release, including human takeover and the limits
of execution handoff. A short pointer in the profile's user-managed `SOUL.md`
can direct browser and handoff requests to it.
It does not add tools or broaden an approval policy.

Configure the browser connectors following the [desktop guide](../desktop/README.md)
and [native VPS browser guide](../desktop/docs/vps-browser.md).
Each independent bot uses its own `--bot-id`, matching its assigned tabs. Use
the existing verified private SSH route for VPS-to-Mac tools. Preserve bounded
timeouts and lazy connection where supported, so an offline Mac does not
prevent the VPS gateway from starting.

The VPS's files and installed software remain shared. Each profile keeps its
own identity, memory and conversation history. This release supplies one shared
VPS desktop with separate agent-owned browser tabs/windows. All bots share
sign-ins within each host's browser profile. Separate desktop streams and
login propagation between Mac and VPS remain additional work.

## Retire legacy profiles recoverably

1. Inventory actual running gateways, native profiles, scheduled jobs, browser
   processes and profile references in prompts or memory. Select the primary
   and optional local/specialist profiles to retain. Keep unrelated services.
2. Drain work and stop the retiring profile's jobs and processes. Save a private
   full snapshot of its configuration, credentials, history, browser data and
   service registrations. Use restrictive permissions and verify the archive
   before retirement. Hermes' portable profile export may redact credentials
   or omit runtime data; inspect the installed release's behavior before using
   it as a recovery backup.
3. Use the installed native profile lifecycle commands to retire the named
   profile, including its routing identity and gateway registration. Check
   their current help first. Keep recovery snapshots outside the active
   `profiles/` directory and outside Git.
4. Replace active roster references to retired profiles with discovery of
   currently available profiles. Preserve business context and work products.
   A Telegram bot account and its chat can remain even when its agent profile
   is retired. Workspace visibility switches are independent of this lifecycle.
5. Verify the primary still replies through Telegram and that Mac/VPS tools
   still reach their intended hosts. Record a private recovery procedure,
   including restoring a named profile's identity through the native lifecycle.

## Updates need a fresh runtime

A running Python gateway can hold already imported modules from an older
checkout while later imports read newly updated files. Restart through
Hermes' supported gateway lifecycle after a code update. Updating files alone
does not establish that the serving process uses a consistent version.

Check the installed release's `hermes gateway restart` and status commands.
Wait for the messaging adapter to be connected before testing. Verify a normal
Telegram request that requires a full agent/model turn and a delivered reply;
a plugin slash command can succeed without exercising the agent loop. Test a
bounded authorized browser action separately when connector compatibility
changes. Keep Hermes source and bundled dependencies stock throughout.

## Pair an existing Telegram bot with a fresh profile

Use one Telegram bot token per native Hermes profile, and one active gateway owner
for that token. Retiring a profile does not delete its Telegram bot or chat.
An inactive bot can be connected to a newly created profile without reusing its
old memory or sessions.

Create the profile through the installed Hermes profile command. Clone its
configuration using native options that leave messaging credentials behind;
check that release's help rather than copying another profile directory.
Configure the existing bot token privately through Hermes' native messaging
setup. Verify `getMe` resolves the intended numeric bot ID and username before
starting the profile. Identify and stop any previous poller/webhook owner first.
Store tokens in the private profile environment, never in app UI metadata or Git.

Use the numeric Telegram bot ID as that profile's Workspace connector `--bot-id`.
This matches the app's discovered Telegram identity directly. A profile name is
not a Telegram ID: assigning a connector the profile name while the UI uses the
numeric Telegram ID creates different tab owners. Give a Mac-only profile a
separate stable identity when it has no Telegram bot. Verify a full agent turn,
a delivered Telegram reply and a bounded action in that profile's assigned tab.
