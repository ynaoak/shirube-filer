import { invoke } from "@tauri-apps/api/core";
import { APP_EVENTS } from "./appEvents";

export type Bookmark = {
  name: string;
  path: string;
  group?: string;
};

/**
 * Add a folder path to the favorites (bookmarks) list at the backend level,
 * so it works whether or not the BookmarkPanel is currently mounted.
 *
 * Returns "added" when a new entry was saved, or "exists" when the path was
 * already bookmarked. Dispatches BOOKMARKS_CHANGED on success so an open
 * BookmarkPanel can reload.
 */
export async function addBookmark(path: string): Promise<"added" | "exists"> {
  if (!path) return "exists";
  const list = await invoke<Bookmark[]>("load_bookmarks");
  if (list.some((b) => b.path === path)) return "exists";
  const name = path.split(/[\\/]/).pop() || path;
  await invoke("save_bookmarks", { bookmarks: [...list, { name, path }] });
  window.dispatchEvent(new CustomEvent(APP_EVENTS.BOOKMARKS_CHANGED));
  return "added";
}
