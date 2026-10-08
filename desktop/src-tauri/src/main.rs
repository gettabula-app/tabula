// Tabula desktop shell (TAB-100): a window around the built web app, plus the glue that hands a `.drift` file the
// operating system asked us to open to the page, board backups and native save dialogs. See docs/desktop.md.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;

use std::{
  collections::HashSet,
  path::{Path, PathBuf},
  sync::Mutex,
};

use tauri::{
  ipc::{InvokeBody, Request, Response},
  AppHandle, Emitter, Manager, State, Url, WebviewWindow,
};
use tauri_plugin_dialog::DialogExt;

/// Files the system asked us to open. `pending` is what the page has not collected yet; `granted` is every path the
/// page may read, so the read command cannot be used on arbitrary paths.
#[derive(Default)]
struct OpenedFiles {
  pending: Vec<PathBuf>,
  granted: HashSet<PathBuf>,
}

type Shared = Mutex<OpenedFiles>;

fn is_drift(path: &std::path::Path) -> bool {
  path.extension().is_some_and(|e| e.eq_ignore_ascii_case("drift"))
}

/// The `.drift` paths among command line arguments: how Windows and Linux pass a file at launch, and how a second
/// instance reports one on every platform. Flags and other arguments are ignored. Linux file managers can pass
/// `file://` URLs; other URLs are dropped and anything else is a path, so `C:\boards\a.drift` is not mistaken for a URL.
fn drift_paths<I: IntoIterator<Item = String>>(args: I) -> Vec<PathBuf> {
  args
    .into_iter()
    .filter(|a| !a.starts_with('-'))
    .filter_map(|a| {
      if a.get(..7).is_some_and(|scheme| scheme.eq_ignore_ascii_case("file://")) {
        Url::parse(&a).ok()?.to_file_path().ok()
      } else if a.contains("://") {
        None
      } else {
        Some(PathBuf::from(a))
      }
    })
    .filter(|p| is_drift(p))
    .collect()
}

fn receive(app: &AppHandle, paths: Vec<PathBuf>) {
  if paths.is_empty() {
    return;
  }
  {
    let state = app.state::<Shared>();
    let mut files = state.lock().unwrap();
    for path in paths {
      files.granted.insert(path.clone());
      files.pending.push(path);
    }
  }
  // The page may not be listening yet (cold start), so it also asks for `pending` once it is up.
  let _ = app.emit("opened-file", ());
}

/// Paths that arrived since the page last asked.
#[tauri::command]
fn take_opened_files(state: State<Shared>) -> Vec<String> {
  let paths = std::mem::take(&mut state.lock().unwrap().pending);
  paths.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// The bytes of a file the system handed us, for `readBoardFile` on the page.
#[tauri::command]
fn read_opened_file(path: String, state: State<Shared>) -> Result<Response, String> {
  let path = PathBuf::from(path);
  if !state.lock().unwrap().granted.contains(&path) {
    return Err("not a file the system asked this app to open".into());
  }
  std::fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

/// `<local app data>/backups`. Local rather than roaming data: on Windows that is `%LOCALAPPDATA%\<identifier>`, next to
/// the webview's own data, and a roaming profile would copy every board backup around at each sign-in. On macOS both are
/// `~/Library/Application Support/<identifier>`.
fn backups_dir(app: &AppHandle) -> Result<PathBuf, String> {
  app.path().app_local_data_dir().map(|d| d.join("backups")).map_err(|e| e.to_string())
}

/// The value of a request header the page set, as text. Header values travel as ASCII.
fn header<'a>(request: &'a Request, name: &str) -> Result<&'a str, String> {
  request.headers().get(name).and_then(|v| v.to_str().ok()).ok_or_else(|| format!("missing header {name}"))
}

/// The raw bytes the page sent with `invoke(cmd, bytes, { headers })`. Raw bodies skip JSON, which matters for a board
/// or an image of several megabytes.
fn body<'a>(request: &'a Request) -> Result<&'a [u8], String> {
  match request.body() {
    InvokeBody::Raw(bytes) => Ok(bytes),
    InvokeBody::Json(_) => Err("expected a raw body".into()),
  }
}

/// Writes the backup copy of a board: the `.drift` bytes in the body, the board id in `x-board-id`.
#[tauri::command]
fn backup_board(app: AppHandle, request: Request) -> Result<(), String> {
  backup::write_backup(&backups_dir(&app)?, header(&request, "x-board-id")?, body(&request)?)
}

/// Ids of the boards that have a backup.
#[tauri::command]
fn list_backups(app: AppHandle) -> Result<Vec<String>, String> {
  backup::list_backups(&backups_dir(&app)?)
}

#[tauri::command]
fn read_backup(app: AppHandle, id: String) -> Result<Response, String> {
  backup::read_backup(&backups_dir(&app)?, &id).map(Response::new)
}

/// Called when the person deletes a board, so the next start does not restore it.
#[tauri::command]
fn delete_backup(app: AppHandle, id: String) -> Result<(), String> {
  backup::delete_backup(&backups_dir(&app)?, &id)
}

/// The suggested name in the save dialog: the last part of what the page sent, never a folder.
fn suggested_name(name: &str) -> String {
  Path::new(name.trim()).file_name().and_then(|n| n.to_str()).filter(|n| !n.is_empty()).unwrap_or("board").to_owned()
}

/// Shows the system Save dialog and writes the bytes in the body to the file the person picks. The page never names
/// the path, so it cannot write anywhere the person did not choose. Returns the path, or `None` if they cancelled.
#[tauri::command]
async fn save_export(window: WebviewWindow, request: Request<'_>) -> Result<Option<String>, String> {
  let name = suggested_name(header(&request, "x-file-name")?);
  let mut dialog = window.dialog().file().set_parent(&window).set_file_name(&name);
  if let Some(ext) = Path::new(&name).extension().and_then(|e| e.to_str()) {
    dialog = dialog.add_filter(format!("{} file", ext.to_uppercase()), &[ext]);
  }
  // The blocking variant must not run on the main thread, which is where a plain command would run.
  let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file()).await.map_err(|e| e.to_string())?;
  let Some(picked) = picked else { return Ok(None) };
  let path = picked.into_path().map_err(|e| e.to_string())?;
  std::fs::write(&path, body(&request)?).map_err(|e| e.to_string())?;
  Ok(Some(path.to_string_lossy().into_owned()))
}

fn main() {
  let app = tauri::Builder::default()
    // Registered first, as the plugin requires. A second launch (Windows and Linux open each double-clicked file in a
    // new process) ends here and reports its arguments to the running instance.
    .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
      receive(app, drift_paths(args.into_iter().skip(1)));
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
      }
    }))
    .plugin(tauri_plugin_dialog::init())
    .manage(Shared::default())
    .invoke_handler(tauri::generate_handler![
      take_opened_files,
      read_opened_file,
      backup_board,
      list_backups,
      read_backup,
      delete_backup,
      save_export
    ])
    .setup(|#[allow(unused_variables)] app| {
      #[cfg(any(windows, target_os = "linux"))]
      receive(app.handle(), drift_paths(std::env::args().skip(1)));
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building Tabula");

  app.run(|#[allow(unused_variables)] app, #[allow(unused_variables)] event| {
    // macOS never passes the file as an argument: LaunchServices sends an open event, at launch or to the running app.
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Opened { urls } = event {
      receive(app, urls.into_iter().filter_map(|u| u.to_file_path().ok()).filter(|p| is_drift(p)).collect());
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn keeps_only_drift_paths() {
    let got = drift_paths(args(&["--flag", "notes.txt", "/tmp/a.drift", "/tmp/B.DRIFT", "/tmp/board.json"]));
    assert_eq!(got, vec![PathBuf::from("/tmp/a.drift"), PathBuf::from("/tmp/B.DRIFT")]);
  }

  #[test]
  fn windows_paths_are_not_urls() {
    let got = drift_paths(args(&[r"C:\Users\ann\boards\retro.drift"]));
    assert_eq!(got, vec![PathBuf::from(r"C:\Users\ann\boards\retro.drift")]);
  }

  #[test]
  fn suggested_name_is_a_file_name_only() {
    assert_eq!(suggested_name("retro-board.drift"), "retro-board.drift");
    assert_eq!(suggested_name("../../etc/passwd"), "passwd");
    assert_eq!(suggested_name("  "), "board");
    assert_eq!(suggested_name(".."), "board");
  }

  #[test]
  #[cfg(unix)]
  fn file_urls_are_decoded() {
    let got = drift_paths(args(&["file:///tmp/my%20board.drift", "https://example.com/a.drift"]));
    assert_eq!(got, vec![PathBuf::from("/tmp/my board.drift")]);
  }
}
