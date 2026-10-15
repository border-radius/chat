// Opening an attachment that isn't shown in the app (a PDF, an archive…), and links in messages (§7.6.3).

import * as Linking from "expo-linking";
import { router } from "expo-router";
import * as Sharing from "expo-sharing";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";

/**
 * Download `url` and offer it to the apps that can open it (the system's share sheet). On the web build, or where
 * sharing isn't available, the file opens in the browser instead.
 */
export async function openFile(url: string, name: string, type?: string): Promise<void> {
  if (Platform.OS === "web" || !(await Sharing.isAvailableAsync())) {
    await Linking.openURL(url);
    return;
  }
  const { Directory, File, Paths } = await import("expo-file-system");
  // A folder per download: two files with the same name never overwrite each other.
  const dir = new Directory(Paths.cache, "attachments", String(Date.now()));
  dir.create({ intermediates: true, idempotent: true });
  const safe = name.replace(/[/\\?%*:|"<>]/g, "_") || "file";
  const file = await File.downloadFileAsync(url, new File(dir, safe));
  await Sharing.shareAsync(file.uri, { ...(type ? { mimeType: type } : {}), dialogTitle: name });
}

/**
 * A link in a message: one to a room on this same server (`https://server/r/abc`, `…/r/abc/m/xyz`) opens it in the
 * app; anything else opens in an in-app browser tab.
 */
export function openLink(href: string, server: string): void {
  const prefix = `${server}/r/`;
  if (href.startsWith(prefix)) {
    const [room, m, msg] = href.slice(prefix.length).split(/[?#]/)[0]!.split("/");
    if (room && (m === undefined || (m === "m" && msg))) {
      router.push({ pathname: "/r/[id]", params: { id: decodeURIComponent(room), ...(msg ? { msg: decodeURIComponent(msg) } : {}) } });
      return;
    }
  }
  void WebBrowser.openBrowserAsync(href).catch(() => Linking.openURL(href));
}
