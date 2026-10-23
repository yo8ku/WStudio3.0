//! Windows Shell destinations; one COM worker serializes list rebuilds and preserves native pins.
use super::arguments::{launch_arguments, launch_file_arguments};
use super::RecentClosedTab;
use crate::RecentRepository;
use std::{
    collections::HashSet,
    ffi::OsString,
    os::windows::ffi::OsStringExt,
    path::Path,
    sync::{mpsc, OnceLock},
};
use windows::core::{w, Interface, HSTRING};
use windows::Win32::Storage::EnhancedStorage::{PKEY_AppUserModel_ID, PKEY_Title};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Variant::VT_LPWSTR;
use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, SHStrDupW,
    SetCurrentProcessExplicitAppUserModelID, ShellLink,
};

const APP_ID: &str = if cfg!(debug_assertions) {
    "com.wstudio.desktop.dev"
} else {
    "com.wstudio.desktop"
};
struct JumpListSnapshot {
    repositories: Vec<RecentRepository>,
    closed_tabs: Vec<RecentClosedTab>,
}

static UPDATES: OnceLock<mpsc::Sender<JumpListSnapshot>> = OnceLock::new();

/// Use the same explicit identity for the application windows and their Jump List.
pub(super) fn set_process_identity() -> windows::core::Result<()> {
    unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APP_ID)) }
}

/// Keep Shell COM work off repository/IPC threads and serialize rapid history changes.
pub(super) fn start_worker() -> Result<(), String> {
    if UPDATES.get().is_some() {
        return Ok(());
    }
    let (sender, receiver) = mpsc::channel::<JumpListSnapshot>();
    std::thread::Builder::new()
        .name("wstudio-jump-list".into())
        .spawn(move || {
            if let Err(error) = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() } {
                eprintln!("[taskbar] Initialize Shell COM failed: {error}");
                return;
            }
            for mut snapshot in receiver.iter() {
                while let Ok(newer) = receiver.try_recv() {
                    snapshot = newer;
                }
                if let Err(error) = refresh(&snapshot.repositories, &snapshot.closed_tabs, APP_ID) {
                    eprintln!("[taskbar] Update recent repositories failed: {error}");
                }
            }
            unsafe { CoUninitialize() };
        })
        .map_err(|error| error.to_string())?;
    let _ = UPDATES.set(sender);
    Ok(())
}

/// Only the running application publishes lists; ordinary persistence tests have no Shell effects.
pub(super) fn queue(recent: Vec<RecentRepository>, closed_tabs: Vec<RecentClosedTab>) {
    if let Some(sender) = UPDATES.get() {
        if sender
            .send(JumpListSnapshot {
                repositories: recent,
                closed_tabs,
            })
            .is_err()
        {
            eprintln!("[taskbar] Jump List worker is no longer running");
        }
    }
}

/// Build a destination link whose visible title is only the repository name.
fn repository_link(
    repository: &RecentRepository,
    executable: &Path,
    app_id: &str,
) -> windows::core::Result<IShellLinkW> {
    let executable_path = executable.to_path_buf();
    let executable = HSTRING::from(executable.as_os_str());
    let arguments = HSTRING::from(launch_arguments(&repository.root_path));
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&executable)?;
        link.SetArguments(&arguments)?;
        let (icon_path, icon_index) = folder_icon_location()?;
        link.SetIconLocation(&HSTRING::from(icon_path), icon_index)?;
        // Use the executable directory, so a moved/deleted repository cannot prevent app launch.
        if let Some(directory) = executable_path.parent() {
            link.SetWorkingDirectory(&HSTRING::from(directory.as_os_str()))?;
        }
        let properties: IPropertyStore = link.cast()?;
        properties.SetValue(&PKEY_Title, &string_property(&repository.name)?)?;
        properties.SetValue(&PKEY_AppUserModel_ID, &string_property(app_id)?)?;
        properties.Commit()?;
        Ok(link)
    }
}

/// Ask the Windows Shell for the user's current stock folder icon location.
fn folder_icon_location() -> windows::core::Result<(OsString, i32)> {
    use windows::Win32::UI::Shell::{
        SHGetStockIconInfo, SHGSI_ICONLOCATION, SHSTOCKICONINFO, SIID_FOLDER,
    };
    let mut info = SHSTOCKICONINFO {
        cbSize: std::mem::size_of::<SHSTOCKICONINFO>() as u32,
        ..Default::default()
    };
    unsafe {
        SHGetStockIconInfo(SIID_FOLDER, SHGSI_ICONLOCATION, &mut info)?;
    }
    let end = info
        .szPath
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(info.szPath.len());
    let path = OsString::from_wide(&info.szPath[..end]);
    if path.is_empty() {
        return Err(windows::core::Error::new(
            windows::Win32::Foundation::E_FAIL,
            "Windows returned an empty folder icon path",
        ));
    }
    Ok((path, info.iIcon))
}

/// Rebuild a single custom category, respecting destinations the user removed through Windows.
fn refresh(
    recent: &[RecentRepository],
    closed_tabs: &[RecentClosedTab],
    app_id: &str,
) -> windows::core::Result<()> {
    let executable = std::env::current_exe().map_err(|error| {
        windows::core::Error::new(windows::Win32::Foundation::E_FAIL, error.to_string())
    })?;
    unsafe {
        let list: ICustomDestinationList =
            CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        list.SetAppID(&HSTRING::from(app_id))?;
        let mut slots = 0;
        let removed: IObjectArray = list.BeginList(&mut slots)?;
        let result = (|| {
            let removed = removed_arguments(&removed)?;
            let repository_objects: IObjectCollection =
                CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            let mut included = HashSet::new();
            let reserved_closed_slots = closed_tabs.len().min(5);
            let repository_slots = (slots as usize).saturating_sub(reserved_closed_slots);
            for repository in recent {
                if included.len() >= repository_slots {
                    break;
                }
                let arguments = launch_arguments(&repository.root_path);
                if !Path::new(&repository.root_path).is_dir()
                    || repository.name.trim().is_empty()
                    || removed.contains(&arguments)
                    || !included.insert(arguments)
                {
                    continue;
                }
                repository_objects.AddObject(&repository_link(repository, &executable, app_id)?)?;
            }
            if !included.is_empty() {
                let objects: IObjectArray = repository_objects.cast()?;
                list.AppendCategory(w!("最近打开的仓库"), &objects)?;
            }

            let closed_objects: IObjectCollection =
                CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            let mut closed_included = HashSet::new();
            for tab in closed_tabs.iter().take(5) {
                if included.len() + closed_included.len() >= slots as usize {
                    break;
                }
                let path = Path::new(&tab.root_path).join(&tab.relative_path);
                if !Path::new(&tab.root_path).is_dir()
                    || !path.is_file()
                    || tab.title.trim().is_empty()
                {
                    continue;
                }
                let arguments = launch_file_arguments(&tab.root_path, &tab.relative_path);
                if removed.contains(&arguments) || !closed_included.insert(arguments.clone()) {
                    continue;
                }
                closed_objects.AddObject(&closed_tab_link(tab, &executable, app_id)?)?;
            }
            if !closed_included.is_empty() {
                let objects: IObjectArray = closed_objects.cast()?;
                list.AppendCategory(w!("最近关闭的标签页"), &objects)?;
            }
            list.CommitList()
        })();
        if result.is_err() {
            let _ = list.AbortList();
        }
        result
    }
}

fn closed_tab_link(
    tab: &RecentClosedTab,
    executable: &Path,
    app_id: &str,
) -> windows::core::Result<IShellLinkW> {
    let executable_path = executable.to_path_buf();
    let executable = HSTRING::from(executable.as_os_str());
    let arguments = HSTRING::from(launch_file_arguments(&tab.root_path, &tab.relative_path));
    let title = format!("{} ({})", tab.title, tab.repository_name);
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&executable)?;
        link.SetArguments(&arguments)?;
        if let Some(directory) = executable_path.parent() {
            link.SetWorkingDirectory(&HSTRING::from(directory.as_os_str()))?;
        }
        let properties: IPropertyStore = link.cast()?;
        properties.SetValue(&PKEY_Title, &string_property(&title)?)?;
        properties.SetValue(&PKEY_AppUserModel_ID, &string_property(app_id)?)?;
        properties.Commit()?;
        Ok(link)
    }
}

/// Shell uses executable plus arguments as a destination identity; do not re-add removed links.
fn removed_arguments(removed: &IObjectArray) -> windows::core::Result<HashSet<String>> {
    let mut arguments = HashSet::new();
    unsafe {
        for index in 0..removed.GetCount()? {
            if let Ok(link) = removed.GetAt::<IShellLinkW>(index) {
                let mut buffer = vec![0u16; 32768];
                link.GetArguments(&mut buffer)?;
                let end = buffer
                    .iter()
                    .position(|value| *value == 0)
                    .unwrap_or(buffer.len());
                arguments.insert(
                    OsString::from_wide(&buffer[..end])
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }
    Ok(arguments)
}
/// Allocate the VT_LPWSTR property expected by Shell; PROPVARIANT owns and frees its COM string.
fn string_property(value: &str) -> windows::core::Result<PROPVARIANT> {
    unsafe {
        let string = SHStrDupW(&HSTRING::from(value))?;
        Ok(PROPVARIANT {
            Anonymous: windows::Win32::System::Com::StructuredStorage::PROPVARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(
                    windows::Win32::System::Com::StructuredStorage::PROPVARIANT_0_0 {
                        vt: VT_LPWSTR,
                        wReserved1: 0,
                        wReserved2: 0,
                        wReserved3: 0,
                        Anonymous:
                            windows::Win32::System::Com::StructuredStorage::PROPVARIANT_0_0_0 {
                                pwszVal: string,
                            },
                    },
                ),
            },
        })
    }
}
