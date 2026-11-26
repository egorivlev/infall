## Downloads

| System | File |
|---|---|
| macOS 11 or newer, Apple silicon | `Infall-{version}-arm64.dmg` |
| macOS 11 or newer, Intel | `Infall-{version}-x64.dmg` |
| Windows 10 or 11, 64-bit | `Infall-{version}-x64-setup.exe` |
| Ubuntu 22.04 or 24.04, Intel/AMD | `infall_{version}_amd64.deb` |
| Ubuntu 22.04 or 24.04, ARM | `infall_{version}_arm64.deb` |

A Team server runs from the container image `{image}:{version}` ([deploy/README.md](https://github.com/{repo}/blob/{tag}/deploy/README.md)).

What has been seen working where: macOS is built and used; Ubuntu (arm64) has run in containers only; **Windows compiles and its installer is built, but Infall has never been started on Windows.** Reports of what happens there are welcome as [issues](https://github.com/{repo}/issues).

## These builds are unsigned: how to open them

Nobody pays Apple or Microsoft to sign Infall, so both systems warn the first time. The warning means the system does not know who made the file; it does not mean anything harmful was found. What ties the file to this release is its SHA-256, listed below and in `SHA256SUMS`. Check it first:

- macOS: `shasum -a 256 ~/Downloads/Infall-{version}-arm64.dmg`
- Windows (PowerShell): `Get-FileHash .\Infall-{version}-x64-setup.exe`
- Ubuntu: `sha256sum infall_{version}_amd64.deb`, or `sha256sum --check --ignore-missing SHA256SUMS` in the folder holding both files

The line it prints must match the one below. If it does not, do not open the file.

**macOS.** Open the `.dmg`, drag Infall onto Applications, and open it. macOS stops it once, saying it could not verify Infall. Click **Done**, then:

- macOS 15 and newer: System Settings › Privacy & Security, scroll to Security, click **Open Anyway** next to the line about Infall, confirm with your password. The button is there for about an hour after the attempt.
- macOS 14 and older: Control-click (right-click) Infall in Applications, choose **Open**, then **Open** again.
- Or, in Terminal, remove the download mark and open it normally: `xattr -dr com.apple.quarantine /Applications/Infall.app`

If macOS says Infall "is damaged", the file changed on the way: download it again and compare the SHA-256.

**Windows.** Open the installer. The blue **Windows protected your PC** window appears: click **More info**, then **Run anyway**. The installer needs no administrator rights. If **Smart App Control** blocks it, there is no way past it for an unsigned file; please say so in an issue.

**Ubuntu.** `sudo apt install ./infall_{version}_amd64.deb` (the `./` matters). The package is not signed; the SHA-256 is the check.

Or build it from source: [README.md](https://github.com/{repo}/blob/{tag}/README.md#build-from-source).

## SHA-256
