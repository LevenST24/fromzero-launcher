//! Lightweight text extraction for Office Open XML packages (PPTX / DOCX / XLSX).
//! These formats are ZIP archives; we only read the relevant XML parts.

use std::io::{Read, Seek};
use std::path::Path;
use zip::ZipArchive;

const MAX_OFFICE_SIZE: u64 = 80 * 1024 * 1024;
const MAX_SLIDES: usize = 12;
const MAX_CHARS: usize = 6000;
const MAX_ENTRY_BYTES: usize = 2 * 1024 * 1024;

/// Decode basic XML character entities found in OOXML text runs.
fn decode_xml_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn strip_inner_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// Extract inner text of every element whose local name equals `local_tag`
/// (supports prefixes such as `a:t`, `w:t`).
fn extract_tag_texts(xml: &str, local_tag: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    let len = xml.len();

    // Pre-build common close tag patterns (avoid per-iteration allocation)
    let close_b = format!("</{}>", local_tag);
    let close_c = format!("</a:{}>", local_tag);
    let close_d = format!("</w:{}>", local_tag);
    let close_e = format!("</t:{}>", local_tag);

    while i < len {
        let Some(rel) = xml[i..].find('<') else {
            break;
        };
        i += rel;
        if i + 1 >= len {
            break;
        }

        // Skip closing tags, comments, PI, CDATA
        let next = xml.as_bytes()[i + 1];
        if next == b'/' || next == b'!' || next == b'?' {
            i += 1;
            continue;
        }

        // Tag name runs until whitespace, '>', or '/'
        let name_start = i + 1;
        let name_end = xml[name_start..]
            .find([' ', '\t', '\n', '\r', '>', '/'])
            .map(|n| name_start + n)
            .unwrap_or(len);
        if name_end <= name_start {
            i += 1;
            continue;
        }
        let full_name = &xml[name_start..name_end];
        let local = full_name.rsplit(':').next().unwrap_or(full_name);
        if local != local_tag {
            i = name_end;
            continue;
        }

        // End of opening tag
        let Some(gt_rel) = xml[name_end..].find('>') else {
            break;
        };
        let open_end = name_end + gt_rel + 1;
        // Self-closing <a:t ... />
        if xml[name_end..open_end].contains('/') {
            i = open_end;
            continue;
        }

        // Closing tag: </full_name> or </prefix:local> variants
        let close_a = format!("</{}>", full_name);

        let search = &xml[open_end..];
        let close_at = [
            close_a.as_str(),
            close_b.as_str(),
            close_c.as_str(),
            close_d.as_str(),
            close_e.as_str(),
        ]
        .iter()
        .filter_map(|p| search.find(p).map(|pos| (pos, p.len())))
        .min_by_key(|(pos, _)| *pos);

        let Some((cpos, clen)) = close_at else {
            i = open_end;
            continue;
        };

        let raw = &search[..cpos];
        let plain = strip_inner_tags(raw);
        let text = decode_xml_entities(&plain);
        if !text.is_empty() {
            out.push(text);
        }
        i = open_end + cpos + clen;
    }
    out
}

fn read_zip_entry_string<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Option<String> {
    let mut file = archive.by_name(name).ok()?;
    if file.size() > MAX_ENTRY_BYTES as u64 {
        return None;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn list_slide_names<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Vec<String> {
    let mut slides = Vec::new();
    for i in 0..archive.len() {
        let Ok(file) = archive.by_index(i) else {
            continue;
        };
        let name = file.name().replace('\\', "/");
        if name.starts_with("ppt/slides/slide") && name.ends_with(".xml") && !name.contains("_rels")
        {
            slides.push(name);
        }
    }
    slides.sort_by(|a, b| {
        let num = |s: &str| {
            s.trim_start_matches("ppt/slides/slide")
                .trim_end_matches(".xml")
                .parse::<u32>()
                .unwrap_or(0)
        };
        num(a).cmp(&num(b))
    });
    slides
}

/// Build a human-readable PPTX preview (per-slide body text).
pub fn preview_pptx(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("无法读取元数据: {}", e))?;
    if meta.len() > MAX_OFFICE_SIZE {
        return Err("PPTX 文件过大，无法预览".to_string());
    }
    let file = std::fs::File::open(path).map_err(|e| format!("无法打开文件: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("不是有效的 PPTX 文件: {}", e))?;

    let slide_names = list_slide_names(&mut archive);
    if slide_names.is_empty() {
        return Ok("（未找到幻灯片内容）".to_string());
    }

    let total = slide_names.len();
    let mut out = String::new();
    out.push_str(&format!("📑 PowerPoint · 共 {} 页\n", total));

    for (idx, slide_name) in slide_names.iter().take(MAX_SLIDES).enumerate() {
        if out.len() >= MAX_CHARS {
            out.push_str("\n…");
            break;
        }
        let Some(xml) = read_zip_entry_string(&mut archive, slide_name) else {
            continue;
        };
        // Paragraphs are </a:p>; runs inside a paragraph are many <a:t> fragments.
        out.push_str(&format!("\n── 第 {} 页 ──\n", idx + 1));
        let mut wrote_any = false;
        for part in xml.split("</a:p>") {
            if out.len() >= MAX_CHARS {
                out.push_str("…\n");
                break;
            }
            let texts = extract_tag_texts(part, "t");
            if texts.is_empty() {
                continue;
            }
            let line = texts.join("");
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            wrote_any = true;
            out.push_str(line);
            out.push('\n');
        }
        if !wrote_any {
            // Fallback: dump all text runs if paragraph split failed
            let texts = extract_tag_texts(&xml, "t");
            if texts.is_empty() {
                out.push_str("（无文本内容）\n");
            } else {
                out.push_str(&texts.join(""));
                out.push('\n');
            }
        }
    }

    if total > MAX_SLIDES {
        out.push_str(&format!("\n… 另有 {} 页未显示", total - MAX_SLIDES));
    }

    Ok(out.trim_end().to_string())
}

/// DOCX body text preview.
pub fn preview_docx(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("无法读取元数据: {}", e))?;
    if meta.len() > MAX_OFFICE_SIZE {
        return Err("DOCX 文件过大，无法预览".to_string());
    }
    let file = std::fs::File::open(path).map_err(|e| format!("无法打开文件: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("不是有效的 DOCX 文件: {}", e))?;

    let xml = read_zip_entry_string(&mut archive, "word/document.xml")
        .ok_or_else(|| "无法读取 Word 文档内容".to_string())?;

    let mut body = String::from("📝 Word 文档\n\n");
    for part in xml.split("</w:p>") {
        if body.len() >= MAX_CHARS {
            body.push_str("\n…");
            break;
        }
        let texts = extract_tag_texts(part, "t");
        if texts.is_empty() {
            continue;
        }
        let line = texts.join("");
        if line.trim().is_empty() {
            continue;
        }
        body.push_str(line.trim());
        body.push('\n');
    }

    if body.trim() == "📝 Word 文档" {
        body.push_str("（无文本内容）");
    }
    Ok(body.trim_end().to_string())
}

/// XLSX: shared strings + first sheet cell values (limited).
pub fn preview_xlsx(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("无法读取元数据: {}", e))?;
    if meta.len() > MAX_OFFICE_SIZE {
        return Err("XLSX 文件过大，无法预览".to_string());
    }
    let file = std::fs::File::open(path).map_err(|e| format!("无法打开文件: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("不是有效的 XLSX 文件: {}", e))?;

    let shared = read_zip_entry_string(&mut archive, "xl/sharedStrings.xml").unwrap_or_default();
    let shared_strings = extract_tag_texts(&shared, "t");

    let mut sheet_name = None;
    for i in 0..archive.len() {
        let Ok(f) = archive.by_index(i) else {
            continue;
        };
        let n = f.name().replace('\\', "/");
        if n.starts_with("xl/worksheets/sheet") && n.ends_with(".xml") {
            sheet_name = Some(n);
            break;
        }
    }
    let Some(sheet) = sheet_name else {
        return Ok("📊 Excel · （未找到工作表）".to_string());
    };
    let sheet_xml = read_zip_entry_string(&mut archive, &sheet).unwrap_or_default();
    let values = extract_tag_texts(&sheet_xml, "v");

    let mut out = String::from("📊 Excel 工作表预览\n\n");
    let mut count = 0;
    for v in values.iter().take(100) {
        let display = if let Ok(idx) = v.parse::<usize>() {
            shared_strings
                .get(idx)
                .cloned()
                .unwrap_or_else(|| v.clone())
        } else {
            v.clone()
        };
        if display.trim().is_empty() {
            continue;
        }
        out.push_str(&display);
        out.push('\t');
        count += 1;
        if count % 6 == 0 {
            out.push('\n');
        }
        if out.len() >= MAX_CHARS {
            out.push_str("\n…");
            break;
        }
    }
    if count == 0 {
        for s in shared_strings.iter().take(40) {
            out.push_str(s);
            out.push('\n');
            if out.len() >= MAX_CHARS {
                break;
            }
        }
    }
    Ok(out.trim_end().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_a_t_runs() {
        let xml = r#"<p><a:t>Hello</a:t><a:t xml:space="preserve"> World</a:t></p>"#;
        let texts = extract_tag_texts(xml, "t");
        assert_eq!(texts, vec!["Hello", " World"]);
    }

    #[test]
    fn extract_w_t_with_entities() {
        let xml = r#"<w:t>A &amp; B &lt;C&gt;</w:t>"#;
        let texts = extract_tag_texts(xml, "t");
        assert_eq!(texts, vec!["A & B <C>"]);
    }

    #[test]
    fn preview_minimal_pptx_if_present() {
        // Optional fixture generated by scratch tooling; skip when absent.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scratch")
            .join("test_preview.pptx");
        if !path.exists() {
            return;
        }
        let text = preview_pptx(&path).expect("pptx preview");
        assert!(text.contains("Hello PPTX Preview"), "got: {}", text);
        assert!(text.contains("中文幻灯片预览测试"), "got: {}", text);
        assert!(text.contains("第 1 页"), "got: {}", text);
    }
}
