// Board backups (docs/desktop.md, "Safety net"): one `<id>.drift` per board in `<app data dir>/backups/`. The page
// writes them after local changes and restores any that its own storage lost. Everything here is plain file handling
// so it can be tested without a window.
use std::{
  fs,
  io::{self, Write},
  path::{Path, PathBuf},
  sync::atomic::{AtomicU64, Ordering},
};

const EXTENSION: &str = "drift";
const TEMP_EXTENSION: &str = "tmp";

/// Names Windows treats as devices whatever the extension, so `nul.drift` would swallow the write.
const WINDOWS_DEVICES: [&str; 4] = ["con", "prn", "aux", "nul"];

/// A board id as the app makes and routes them (`parseRoute` in `src/route.ts`): 1 to 64 of `A-Z a-z 0-9 _ -`.
/// Anything else, and anything that is a Windows device name, is refused, so an id can never leave the folder.
pub fn valid_id(id: &str) -> bool {
  let shape = !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
  let lower = id.to_ascii_lowercase();
  let numbered = |prefix: &str| lower.strip_prefix(prefix).is_some_and(|n| n.len() == 1 && matches!(n.as_bytes()[0], b'1'..=b'9'));
  shape && !WINDOWS_DEVICES.contains(&lower.as_str()) && !numbered("com") && !numbered("lpt")
}

/// `<dir>/<id>.drift` for a valid id.
pub fn backup_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
  if !valid_id(id) {
    return Err("not a board id".into());
  }
  Ok(dir.join(format!("{id}.{EXTENSION}")))
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Writes `<id>.drift` by writing a temp file in the same folder, flushing it to disk and renaming it over the target,
/// so a crash or a full disk leaves the previous backup whole. `rename` replaces an existing file on every platform.
pub fn write_backup(dir: &Path, id: &str, bytes: &[u8]) -> Result<(), String> {
  let target = backup_path(dir, id)?;
  fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  let temp = dir.join(format!("{id}.{}.{TEMP_EXTENSION}", TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
  let result = fs::File::create(&temp)
    .and_then(|mut f| f.write_all(bytes).and_then(|_| f.sync_all()))
    .and_then(|_| fs::rename(&temp, &target));
  if result.is_err() {
    let _ = fs::remove_file(&temp);
  }
  result.map_err(|e| e.to_string())
}

pub fn read_backup(dir: &Path, id: &str) -> Result<Vec<u8>, String> {
  fs::read(backup_path(dir, id)?).map_err(|e| e.to_string())
}

/// Removing a backup that is not there is fine: the goal is that it does not exist.
pub fn delete_backup(dir: &Path, id: &str) -> Result<(), String> {
  match fs::remove_file(backup_path(dir, id)?) {
    Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.to_string()),
    _ => Ok(()),
  }
}

/// Ids of the boards that have a backup. Temp files and anything else in the folder are ignored.
pub fn list_backups(dir: &Path) -> Result<Vec<String>, String> {
  let entries = match fs::read_dir(dir) {
    Ok(entries) => entries,
    Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
    Err(e) => return Err(e.to_string()),
  };
  let mut ids: Vec<String> = entries
    .filter_map(|e| e.ok())
    .map(|e| e.path())
    .filter(|p| p.extension().is_some_and(|x| x == EXTENSION))
    .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(str::to_owned))
    .filter(|id| valid_id(id))
    .collect();
  ids.sort();
  Ok(ids)
}

#[cfg(test)]
mod tests {
  use super::*;

  /// A fresh empty folder under the system temp dir, removed on drop.
  struct TempDir(PathBuf);

  impl TempDir {
    fn new() -> Self {
      static N: AtomicU64 = AtomicU64::new(0);
      let dir = std::env::temp_dir().join(format!("tabula-backup-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
      let _ = fs::remove_dir_all(&dir);
      TempDir(dir)
    }
  }

  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  #[test]
  fn accepts_the_ids_the_app_makes() {
    assert!(valid_id("aZ09-_xYz"));
    assert!(valid_id("a"));
    assert!(valid_id(&"x".repeat(64)));
  }

  #[test]
  fn rejects_ids_that_could_leave_the_folder_or_are_not_ids() {
    for id in ["", "..", ".", "../x", "a/b", r"a\b", "a.b", "a b", "ä", "a\0b", "C:x", "x/../y", &"x".repeat(65)] {
      assert!(!valid_id(id), "{id:?} must be refused");
      assert!(backup_path(Path::new("/b"), id).is_err(), "{id:?} must have no path");
    }
  }

  #[test]
  fn rejects_windows_device_names() {
    for id in ["nul", "NUL", "con", "Aux", "prn", "com1", "COM9", "lpt3"] {
      assert!(!valid_id(id), "{id} must be refused");
    }
    for id in ["com", "com0", "com10", "nulx", "lpt", "console"] {
      assert!(valid_id(id), "{id} is an ordinary id");
    }
  }

  #[test]
  fn path_stays_inside_the_folder() {
    let p = backup_path(Path::new("/data/backups"), "abc_DEF-1").unwrap();
    assert_eq!(p, Path::new("/data/backups/abc_DEF-1.drift"));
  }

  #[test]
  fn writes_replaces_and_reads_back_without_leaving_temp_files() {
    let t = TempDir::new();
    let dir = t.0.join("backups");
    write_backup(&dir, "board1", b"first").unwrap();
    write_backup(&dir, "board1", b"second, longer").unwrap();
    assert_eq!(read_backup(&dir, "board1").unwrap(), b"second, longer");
    let names: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec!["board1.drift"]);
  }

  #[test]
  fn refuses_to_write_for_a_bad_id_and_creates_nothing() {
    let t = TempDir::new();
    assert!(write_backup(&t.0, "../escape", b"x").is_err());
    assert!(!t.0.exists());
    assert!(!t.0.parent().unwrap().join("escape.drift").exists());
  }

  #[test]
  fn a_failed_write_keeps_the_previous_backup_and_cleans_up() {
    let t = TempDir::new();
    write_backup(&t.0, "board1", b"kept").unwrap();
    // A directory in the way of the target makes the rename fail after the temp file was written.
    fs::remove_file(t.0.join("board1.drift")).unwrap();
    fs::create_dir(t.0.join("board1.drift")).unwrap();
    assert!(write_backup(&t.0, "board1", b"lost").is_err());
    let leftovers: Vec<_> = fs::read_dir(&t.0).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(leftovers, vec!["board1.drift"]);
  }

  #[test]
  fn lists_only_valid_backups_and_ignores_temp_and_foreign_files() {
    let t = TempDir::new();
    assert_eq!(list_backups(&t.0).unwrap(), Vec::<String>::new());
    fs::create_dir_all(&t.0).unwrap();
    write_backup(&t.0, "bbb", b"1").unwrap();
    write_backup(&t.0, "aaa", b"2").unwrap();
    for stray in ["aaa.0.tmp", "notes.txt", "bad id.drift", ".drift"] {
      fs::write(t.0.join(stray), b"x").unwrap();
    }
    assert_eq!(list_backups(&t.0).unwrap(), vec!["aaa", "bbb"]);
  }

  #[test]
  fn delete_is_idempotent() {
    let t = TempDir::new();
    write_backup(&t.0, "gone", b"x").unwrap();
    delete_backup(&t.0, "gone").unwrap();
    delete_backup(&t.0, "gone").unwrap();
    assert_eq!(list_backups(&t.0).unwrap(), Vec::<String>::new());
    assert!(delete_backup(&t.0, "../x").is_err());
  }
}
