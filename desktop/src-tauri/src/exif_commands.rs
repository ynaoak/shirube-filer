use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufReader;
use std::path::Path;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifData {
    // Camera
    pub make: Option<String>,
    pub model: Option<String>,
    pub software: Option<String>,
    pub artist: Option<String>,
    pub copyright: Option<String>,
    // Date/time
    pub datetime: Option<String>,
    pub datetime_original: Option<String>,
    pub datetime_digitized: Option<String>,
    // Image dimensions
    pub image_width: Option<u32>,
    pub image_height: Option<u32>,
    pub orientation: Option<u16>,
    // Exposure
    pub exposure_time: Option<String>,
    pub f_number: Option<String>,
    pub iso_speed: Option<u32>,
    pub focal_length: Option<String>,
    pub exposure_bias: Option<String>,
    pub metering_mode: Option<String>,
    pub flash: Option<String>,
    pub white_balance: Option<String>,
    // GPS
    pub gps_latitude: Option<f64>,
    pub gps_longitude: Option<f64>,
    pub gps_altitude: Option<f64>,
}

fn rational_to_f64(r: &exif::Rational) -> f64 {
    if r.denom == 0 {
        0.0
    } else {
        r.num as f64 / r.denom as f64
    }
}

fn srational_to_f64(r: &exif::SRational) -> f64 {
    if r.denom == 0 {
        0.0
    } else {
        r.num as f64 / r.denom as f64
    }
}

fn dms_to_decimal(rationals: &[exif::Rational], reference: &str) -> Option<f64> {
    if rationals.len() < 3 {
        return None;
    }
    let d = rational_to_f64(&rationals[0]);
    let m = rational_to_f64(&rationals[1]);
    let s = rational_to_f64(&rationals[2]);
    let decimal = d + m / 60.0 + s / 3600.0;
    if reference == "S" || reference == "W" {
        Some(-decimal)
    } else {
        Some(decimal)
    }
}

fn get_ascii(field: &exif::Field) -> Option<String> {
    match &field.value {
        exif::Value::Ascii(v) => {
            let s = v.iter()
                .filter_map(|bytes| std::str::from_utf8(bytes).ok())
                .collect::<Vec<_>>()
                .join("");
            let trimmed = s.trim_end_matches('\0').trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        }
        _ => None,
    }
}

fn get_short(field: &exif::Field, idx: usize) -> Option<u16> {
    match &field.value {
        exif::Value::Short(v) => v.get(idx).copied(),
        _ => None,
    }
}

fn get_long(field: &exif::Field, idx: usize) -> Option<u32> {
    match &field.value {
        exif::Value::Long(v) => v.get(idx).copied(),
        _ => None,
    }
}

fn get_rational(field: &exif::Field, idx: usize) -> Option<exif::Rational> {
    match &field.value {
        exif::Value::Rational(v) => v.get(idx).copied(),
        _ => None,
    }
}

fn get_srational(field: &exif::Field, idx: usize) -> Option<exif::SRational> {
    match &field.value {
        exif::Value::SRational(v) => v.get(idx).copied(),
        _ => None,
    }
}

fn get_rationals<'a>(field: &'a exif::Field) -> Option<&'a [exif::Rational]> {
    match &field.value {
        exif::Value::Rational(v) => Some(v),
        _ => None,
    }
}

fn metering_mode_str(v: u16) -> &'static str {
    match v {
        0 => "Unknown",
        1 => "Average",
        2 => "Center-weighted",
        3 => "Spot",
        4 => "Multi-spot",
        5 => "Multi-segment",
        6 => "Partial",
        _ => "Other",
    }
}

fn flash_str(v: u16) -> &'static str {
    if v & 0x01 == 0 { "未発光" } else { "発光" }
}

fn white_balance_str(v: u16) -> &'static str {
    match v {
        0 => "Auto",
        1 => "Manual",
        _ => "Unknown",
    }
}

fn orientation_str(v: u16) -> &'static str {
    match v {
        1 => "Normal",
        2 => "Mirrored",
        3 => "Rotated 180°",
        4 => "Mirrored & Rotated 180°",
        5 => "Mirrored & Rotated 90° CW",
        6 => "Rotated 90° CW",
        7 => "Mirrored & Rotated 90° CCW",
        8 => "Rotated 90° CCW",
        _ => "Unknown",
    }
}

#[tauri::command(async)]
pub fn get_exif_data(path: String) -> Result<ExifData, String> {
    let p = Path::new(&path);
    let file = File::open(p).map_err(|e| e.to_string())?;
    let mut buf = BufReader::new(file);

    let reader = exif::Reader::new();
    let exif = reader.read_from_container(&mut buf).map_err(|e| e.to_string())?;

    let mut data = ExifData {
        make: None, model: None, software: None, artist: None, copyright: None,
        datetime: None, datetime_original: None, datetime_digitized: None,
        image_width: None, image_height: None, orientation: None,
        exposure_time: None, f_number: None, iso_speed: None,
        focal_length: None, exposure_bias: None, metering_mode: None,
        flash: None, white_balance: None,
        gps_latitude: None, gps_longitude: None, gps_altitude: None,
    };

    let mut gps_lat_ref = String::new();
    let mut gps_lon_ref = String::new();
    let mut gps_lat_dms: Option<Vec<exif::Rational>> = None;
    let mut gps_lon_dms: Option<Vec<exif::Rational>> = None;

    for field in exif.fields() {
        match field.tag {
            exif::Tag::Make => { data.make = get_ascii(field); }
            exif::Tag::Model => { data.model = get_ascii(field); }
            exif::Tag::Software => { data.software = get_ascii(field); }
            exif::Tag::Artist => { data.artist = get_ascii(field); }
            exif::Tag::Copyright => { data.copyright = get_ascii(field); }
            exif::Tag::DateTime => { data.datetime = get_ascii(field); }
            exif::Tag::DateTimeOriginal => { data.datetime_original = get_ascii(field); }
            exif::Tag::DateTimeDigitized => { data.datetime_digitized = get_ascii(field); }
            exif::Tag::ImageWidth => {
                data.image_width = get_long(field, 0).or_else(|| get_short(field, 0).map(|v| v as u32));
            }
            exif::Tag::ImageLength => {
                data.image_height = get_long(field, 0).or_else(|| get_short(field, 0).map(|v| v as u32));
            }
            exif::Tag::PixelXDimension => {
                if data.image_width.is_none() {
                    data.image_width = get_long(field, 0).or_else(|| get_short(field, 0).map(|v| v as u32));
                }
            }
            exif::Tag::PixelYDimension => {
                if data.image_height.is_none() {
                    data.image_height = get_long(field, 0).or_else(|| get_short(field, 0).map(|v| v as u32));
                }
            }
            exif::Tag::Orientation => { data.orientation = get_short(field, 0); }
            exif::Tag::ExposureTime => {
                if let Some(r) = get_rational(field, 0) {
                    if r.num == 0 || r.denom == 0 {
                        data.exposure_time = Some("0".to_string());
                    } else if r.num == 1 {
                        data.exposure_time = Some(format!("1/{}", r.denom));
                    } else {
                        let val = rational_to_f64(&r);
                        data.exposure_time = Some(format!("{:.4} s", val));
                    }
                }
            }
            exif::Tag::FNumber => {
                if let Some(r) = get_rational(field, 0) {
                    data.f_number = Some(format!("f/{:.1}", rational_to_f64(&r)));
                }
            }
            exif::Tag::PhotographicSensitivity => {
                data.iso_speed = get_short(field, 0).map(|v| v as u32)
                    .or_else(|| get_long(field, 0));
            }
            exif::Tag::FocalLength => {
                if let Some(r) = get_rational(field, 0) {
                    data.focal_length = Some(format!("{:.1} mm", rational_to_f64(&r)));
                }
            }
            exif::Tag::ExposureBiasValue => {
                if let Some(r) = get_srational(field, 0) {
                    let val = srational_to_f64(&r);
                    data.exposure_bias = Some(format!("{:+.1} EV", val));
                }
            }
            exif::Tag::MeteringMode => {
                if let Some(v) = get_short(field, 0) {
                    data.metering_mode = Some(metering_mode_str(v).to_string());
                }
            }
            exif::Tag::Flash => {
                if let Some(v) = get_short(field, 0) {
                    data.flash = Some(flash_str(v).to_string());
                }
            }
            exif::Tag::WhiteBalance => {
                if let Some(v) = get_short(field, 0) {
                    data.white_balance = Some(white_balance_str(v).to_string());
                }
            }
            exif::Tag::GPSLatitudeRef => {
                gps_lat_ref = get_ascii(field).unwrap_or_default();
            }
            exif::Tag::GPSLongitudeRef => {
                gps_lon_ref = get_ascii(field).unwrap_or_default();
            }
            exif::Tag::GPSLatitude => {
                if let Some(rationals) = get_rationals(field) {
                    gps_lat_dms = Some(rationals.to_vec());
                }
            }
            exif::Tag::GPSLongitude => {
                if let Some(rationals) = get_rationals(field) {
                    gps_lon_dms = Some(rationals.to_vec());
                }
            }
            exif::Tag::GPSAltitude => {
                if let Some(r) = get_rational(field, 0) {
                    data.gps_altitude = Some(rational_to_f64(&r));
                }
            }
            _ => {}
        }
    }

    // Convert GPS DMS to decimal
    if let Some(lat_dms) = &gps_lat_dms {
        data.gps_latitude = dms_to_decimal(lat_dms, &gps_lat_ref);
    }
    if let Some(lon_dms) = &gps_lon_dms {
        data.gps_longitude = dms_to_decimal(lon_dms, &gps_lon_ref);
    }

    // Orientation: convert to human-readable string and store as string
    // (keeping the numeric value in the struct for frontend use)
    let _ = orientation_str; // suppress warning; frontend interprets the numeric value

    Ok(data)
}
