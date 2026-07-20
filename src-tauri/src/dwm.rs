//! Windows DWM (Desktop Window Manager) integration helpers.
//! Centralizes all DwmSetWindowAttribute calls to avoid code duplication.

#[cfg(target_os = "windows")]
use std::ffi::c_void;
#[cfg(target_os = "windows")]
use std::sync::OnceLock;

#[cfg(target_os = "windows")]
type DwmSetWindowAttributeFn = unsafe extern "system" fn(
    hwnd: *mut c_void,
    dw_attribute: u32,
    pv_attribute: *const c_void,
    cb_attribute: u32,
) -> i32;

#[cfg(target_os = "windows")]
static DWM_FUNC: OnceLock<Option<DwmSetWindowAttributeFn>> = OnceLock::new();

#[cfg(target_os = "windows")]
fn get_dwm_func() -> Option<DwmSetWindowAttributeFn> {
    *DWM_FUNC.get_or_init(|| unsafe {
        let module_name = std::ffi::CString::new("dwmapi.dll").expect("hardcoded ASCII string");
        let handle = winapi::um::libloaderapi::LoadLibraryA(module_name.as_ptr());
        if handle.is_null() {
            return None;
        }
        let func_name =
            std::ffi::CString::new("DwmSetWindowAttribute").expect("hardcoded ASCII string");
        let proc_addr = winapi::um::libloaderapi::GetProcAddress(handle, func_name.as_ptr());
        if proc_addr.is_null() {
            return None;
        }
        Some(std::mem::transmute(proc_addr))
    })
}

/// Safely call DwmSetWindowAttribute on a raw HWND.
/// The DLL handle is cached after first load (Windows keeps it resident anyway).
#[cfg(target_os = "windows")]
pub fn set_dwm_attribute(raw_hwnd: *mut c_void, attribute: u32, value: u32) -> Result<(), String> {
    let dwm_set = get_dwm_func().ok_or("Failed to load DwmSetWindowAttribute")?;

    let hr = unsafe {
        dwm_set(
            raw_hwnd,
            attribute,
            &value as *const _ as *const c_void,
            std::mem::size_of::<u32>() as u32,
        )
    };
    if hr == 0 {
        Ok(())
    } else {
        Err(format!(
            "DwmSetWindowAttribute({}) failed: hr = {}",
            attribute, hr
        ))
    }
}
