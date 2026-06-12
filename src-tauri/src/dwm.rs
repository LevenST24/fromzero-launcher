//! Windows DWM (Desktop Window Manager) integration helpers.
//! Centralizes all DwmSetWindowAttribute calls to avoid code duplication.

#[cfg(target_os = "windows")]
use std::ffi::c_void;

/// Safely call DwmSetWindowAttribute on a raw HWND.
/// Loads dwmapi.dll dynamically each time (safe, since Windows caches the DLL handle).
#[cfg(target_os = "windows")]
pub fn set_dwm_attribute(raw_hwnd: *mut c_void, attribute: u32, value: u32) -> Result<(), String> {
    type DwmSetWindowAttributeFn = unsafe extern "system" fn(
        hwnd: *mut c_void,
        dw_attribute: u32,
        pv_attribute: *const c_void,
        cb_attribute: u32,
    ) -> i32;

    unsafe {
        let module_name = std::ffi::CString::new("dwmapi.dll").expect("hardcoded ASCII string");
        let handle = winapi::um::libloaderapi::LoadLibraryA(module_name.as_ptr());
        if handle.is_null() {
            return Err("Failed to load dwmapi.dll".to_string());
        }
        let func_name =
            std::ffi::CString::new("DwmSetWindowAttribute").expect("hardcoded ASCII string");
        let proc_addr = winapi::um::libloaderapi::GetProcAddress(handle, func_name.as_ptr());
        if proc_addr.is_null() {
            winapi::um::libloaderapi::FreeLibrary(handle);
            return Err("DwmSetWindowAttribute not found".to_string());
        }
        let dwm_set: DwmSetWindowAttributeFn = std::mem::transmute(proc_addr);

        let hr = dwm_set(
            raw_hwnd,
            attribute,
            &value as *const _ as *const c_void,
            std::mem::size_of::<u32>() as u32,
        );
        winapi::um::libloaderapi::FreeLibrary(handle);
        if hr == 0 {
            Ok(())
        } else {
            Err(format!(
                "DwmSetWindowAttribute({}) failed: hr = {}",
                attribute, hr
            ))
        }
    }
}
