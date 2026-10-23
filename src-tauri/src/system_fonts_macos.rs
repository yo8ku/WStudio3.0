//! Enumerate the font families available to macOS applications, including font collections.
use core_foundation::{
    array::{CFArray, CFArrayRef},
    base::TCFType,
    string::CFString,
};

#[link(name = "CoreText", kind = "framework")]
extern "C" {
    fn CTFontManagerCopyAvailableFontFamilyNames() -> CFArrayRef;
}

pub(crate) fn list_fonts() -> Result<Vec<String>, String> {
    // SAFETY: CoreText returns an owned CFArray of CFStrings; the wrapper releases it.
    let families = unsafe {
        let array = CTFontManagerCopyAvailableFontFamilyNames();
        if array.is_null() {
            return Err("SYSTEM_FONTS_UNAVAILABLE".to_string());
        }
        CFArray::<CFString>::wrap_under_create_rule(array)
    };
    // Keep the exact family name: words such as "Condensed" can belong to a family.
    let mut fonts: Vec<String> = families
        .iter()
        .map(|family| family.to_string())
        .filter(|family| !family.trim().is_empty())
        .collect();
    fonts.sort_unstable_by_key(|family| family.to_lowercase());
    fonts.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    Ok(fonts)
}

#[cfg(test)]
mod tests {
    #[test]
    fn enumerates_installed_macos_families() {
        let fonts = super::list_fonts().expect("CoreText font enumeration should succeed");
        assert!(!fonts.is_empty(), "macOS must expose its installed font families");
        assert!(fonts.iter().all(|family| !family.trim().is_empty()));
        assert!(fonts.windows(2).all(|pair| {
            pair[0].to_lowercase() <= pair[1].to_lowercase()
                && !pair[0].eq_ignore_ascii_case(&pair[1])
        }));
    }
}
