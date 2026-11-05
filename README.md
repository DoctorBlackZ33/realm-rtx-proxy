Hey there, I was annoyed that i could not run RTX Resource Packs and other custom Resource Packs on a Realm that forces Resource Packs, i made this with OpenAI's models and hope it helps someone. As you will read in the next lines this is fully slopped and i don't intend to maintain this unless i need it, feel free to fork and do whatever you like, its MIT licensed so do however you wish and hopefully you can now get better looking Minecraft Bedrock too or well, use Java. :)

# Realm RTX Proxy

> **AI-WRITTEN — Co-authored with OpenAI Codex.** The original implementation and documentation were written by OpenAI Codex under human direction; a human performed runtime testing. This is not a claim that a human reviewed every line. See [AI-DISCLOSURE.md](AI-DISCLOSURE.md).

Realm RTX Proxy is a local, portable bridge for an authorized Minecraft Bedrock Realm account. It can make the Realm's three required-resource-pack flags optional for the client while keeping the Realm-provided packs and their contents in place. It does not include resource packs, change Realm settings or content, bypass Realm access, patch game memory, or install a client DLL. You must already have access to the Realm and use normal Microsoft sign-in.

During a connection, Minecraft client authentication terminates at this trusted local proxy: it verifies the client's authenticated identity and opens its own authenticated connection to the Realm. The proxy never asks you for a Microsoft password or extracts existing game credentials; sign-in uses a Microsoft device code in your own browser. Run it only on a computer and network you trust. It is not affiliated with Mojang or Microsoft.

## Download and run

Get the release for your operating system from [GitHub Releases](https://github.com/DoctorBlackZ33/realm-rtx-proxy/releases/latest). Keep the extracted `realm-rtx-proxy` folder together.

- **Windows x64:** download the ZIP, extract it, and double-click `Start-Proxy.bat` inside the `realm-rtx-proxy` folder.
- **Linux x64 with glibc:** download the `.tar.gz`, extract it, open a terminal in the extracted `realm-rtx-proxy` folder, and run `./start-proxy.sh`. Alpine Linux and other musl-based systems are not supported.

The portable release bundles the x64 Node.js 24.22.2 runtime and locked dependencies. You do not need to install Node.js or npm, use an administrator account, or install anything system-wide. Linux is supported as a proxy host only; this does not provide native Minecraft Bedrock RTX gameplay on Linux.

For a source checkout, use Node.js 24 or later and npm:

```sh
npm ci --ignore-scripts
npm start
```

## Start and connect

1. Before joining, enable a compatible RTX resource pack in Minecraft's global resource-pack settings. BetterRTX is a separate optional shader installation and is not bundled here. In-world RTX requires an RTX-capable Windows Minecraft setup and GPU.
2. Start the proxy. Its default listener is local-only at `127.0.0.1:19132`. Leave its window or terminal open. The program prints its local connection address and reminds you that its proxy authentication cache is private.
3. In Minecraft Bedrock, go to **Play → Servers → Add Server**. Enter:
   - **Server name:** `RealmRTXProxy`
   - **Address:** `127.0.0.1`
   - **Port:** `19132`
4. Save and connect to that external server. Minecraft may show its modern HTTP operator-trust prompt. Accept it manually only when you are connecting to your own proxy on your own machine and recognize the local operator. This is a first-use trust decision, not a TLS certificate prompt.
5. If the proxy asks for Microsoft device sign-in, open the HTTPS URL printed by the proxy in your own browser and enter its code there. Sign in with the Microsoft account that has access to the Realm; never share the device code. When the terminal lists accessible Realms, enter the number for the intended Realm. Keep the proxy running while you play.

A normal startup includes lines like:

```text
http-capability=verified protocol=2225 codec-version=1.26.60 port=19132
listening=127.0.0.1:19132 game-version=1.26.62.1 codec-version=1.26.60 protocol=2225 mode=all
```

After a successful join, `client=authenticated` and `client=spawned` indicate that the client authenticated and reached the in-world spawn phase. The startup capability lines alone do not mean a Realm join succeeded.

## Configuration and command-line options

Edit `config.json` in the app folder before starting. The shipped defaults are:

```json
{
  "version": "1.26.60",
  "gameVersion": "1.26.62.1",
  "host": "127.0.0.1",
  "port": 19132,
  "mode": "all"
}
```

`version` selects the Bedrock packet codec; `gameVersion` is the observed Minecraft build. They are intentionally different for the verified combination: Minecraft 1.26.62.1 uses wire protocol 2225 with codec 1.26.60. These values do not promise compatibility with other game builds. When a future protocol is supported, use a matching tested codec and game build; do not simply bump `gameVersion`.

The launchers accept command-line values that override the corresponding configuration fields. For example, to run unchanged passthrough for one launch:

```sh
./start-proxy.sh --mode passthrough
```

On Windows, run `Start-Proxy.bat --mode passthrough` from Command Prompt or PowerShell. Supported options include:

| Option | Meaning |
| --- | --- |
| `--version <v>` | Supported Bedrock packet codec version. |
| `--game-version <v>` | Installed Minecraft build to use for Realm services. |
| `--host <address>` | Listener address; loopback or a private LAN address only. |
| `--port <port>` | Listener port (default `19132`). |
| `--mode passthrough\|individual\|all` | Forward all required flags unchanged, change one selected flag, or change all three. |
| `--field info\|stack\|start-game` | Select a single flag when using `individual` mode. |
| `--realm-id <numeric-id>` | Select an accessible Realm directly instead of using the terminal list. Treat the ID as private. |
| `--help` | Show command-line help. |

In `all` mode the proxy makes only these selected true values false: `resource_packs_info.must_accept`, `resource_pack_stack.must_accept`, and `start_game.is_texturepacks_required`. In `individual` mode, choose one corresponding field (`info`, `stack`, or `start-game`). Other packet fields, pack IDs and lists, stack order, pack data, and client pack responses are not intentionally changed. A missing or unexpected selected flag stops that connection instead of guessing.

## Network and account security

- The default loopback address is recommended when Minecraft runs on the same computer. To connect from another device on your LAN, change `host` to the proxy computer's private LAN address and connect Minecraft to that address. Allow access only on a network you trust. NetherNet signaling uses plain HTTP, not TLS; authenticated SDP does not encrypt the HTTP exchange. **Do not port-forward this service or expose it to the public internet.**
- The proxy authentication cache at `~/.realm-pack-proxy/auth` (under your user profile on Windows) contains private sign-in data for your account. Windows permissions are inherited from your profile directory; the app does not enforce an owner-only Windows ACL. Do not share or publish the cache. Delete that `auth` directory manually when finished if you want to remove the saved sign-in and require a fresh login next time.
- The separate `~/.realm-pack-proxy/operator-key.pem` is the proxy's private identity key. Never share it. Keep it to preserve the same local operator identity; deleting or replacing it is an intentional trust-identity reset and can trigger a new client trust decision. Do not delete it as routine auth cleanup.
- The terminal's Realm picker displays the names of Realms available to your account. Before sharing screenshots or logs for support, remove Realm names, IDs, device codes, usernames, and any local paths. Never include the auth cache or operator key in an issue, source archive, or release.

To stop the proxy, press **Ctrl+C** in its window or terminal.

## Troubleshooting

- **Waiting for a Realm number:** finish the Microsoft device-code sign-in in your own browser, then type the number for the intended Realm into the proxy terminal. Keep that terminal open.
- **`ModifiedWorld` appears in Minecraft:** this alone does not establish whether Realm authentication succeeded. Check the proxy terminal for the connection phase and `client=spawned`; do not treat the label as a Microsoft sign-in result.
- **`Terracotta`, `Kelp`, or a proxy line `client=rejected reason=version-mismatch`:** check protocol compatibility first. The client's wire protocol must match the selected `version` codec. Merely changing `gameVersion` does not add a missing codec or support a new protocol.

## Compatibility and evidence

The verified end-to-end RTX use was on Windows Minecraft Bedrock 1.26.62.1 (wire protocol 2225) with codec 1.26.60. A passthrough join spawned with all three required flags true. A subsequent `all`-mode join changed those three flags from true to false and spawned; the user confirmed the global-pack RTX setup working on the Realm alongside its provided packs. Both observed joins used cached packs, so they do not prove a fresh uncached pack download. Repeated optional-mode reconnects and a broader version matrix are not established. Linux is a proxy build, not a claim of Linux Minecraft RTX support.

Both portable packages were extracted and smoke-tested with their bundled runtimes: Linux `start-proxy.sh` and Windows `Start-Proxy.bat` served the expected HTTP discovery metadata, accepted port/mode overrides, and shut down cleanly. Archive inspection checked the explicit application-file allowlist and excluded operator keys, auth caches, private configuration and session logs. These startup checks do not constitute a second full Realm/RTX test of each package.

### Linux gameplay versus Linux proxy hosting

The Linux package runs the proxy, not a native Bedrock RTX client. [Flarial's Linux launcher](https://github.com/flarialmc/linux) and [BedrockOnLinux](https://github.com/Wyze3306/BedrockOnLinux) provide experimental Windows-game routes through Wine/GDK-Proton. An [RX 9070 XT community report](https://github.com/Wyze3306/BedrockOnLinux/issues/153) describes ray tracing working but stutter and BetterRTX shader-version problems. The exact Minecraft/Flarial/BetterRTX combination verified above has not been tested through that compatibility route. Android-based Linux Bedrock launchers and Java shader packs are not equivalent to the Windows DXR/BetterRTX pipeline or this Bedrock Realm setup.

For the protocol background, see Mojang's [HTTP NetherNet Partner Onboarding Guide](https://github.com/Mojang/bedrock-protocol-docs/blob/f8d1496b5efc95105bd9ae1f2f2f076a43f71d82/additional_docs/NetherNetOnboardingGuide.md).

## Build releases

From the repository with Node.js 24 and npm installed, build portable archives with:

```sh
node scripts/build-release.mjs --platform all
```

The build produces Windows x64 ZIP and Linux x64 tar.gz archives plus `SHA256SUMS` under `dist/`. See the [project repository](https://github.com/DoctorBlackZ33/realm-rtx-proxy) and its [release downloads](https://github.com/DoctorBlackZ33/realm-rtx-proxy/releases).
