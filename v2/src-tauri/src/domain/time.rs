use serde::{Deserialize, Deserializer, Serialize, de::Error as _};

use crate::error::AppError;

const MICROSECONDS_PER_SECOND: i128 = 1_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct MediaTime(pub i64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRate {
    pub numerator: u32,
    pub denominator: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeRange {
    start: MediaTime,
    end: MediaTime,
}

impl TimeRange {
    pub fn new(start: i64, end: i64) -> Result<Self, AppError> {
        if end <= start {
            return Err(AppError::InvalidInput(
                "time range end must be greater than start".into(),
            ));
        }

        Ok(Self {
            start: MediaTime(start),
            end: MediaTime(end),
        })
    }

    pub fn start(self) -> MediaTime {
        self.start
    }

    pub fn end(self) -> MediaTime {
        self.end
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimeRangeData {
    start: MediaTime,
    end: MediaTime,
}

impl<'de> Deserialize<'de> for TimeRange {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let data = TimeRangeData::deserialize(deserializer)?;
        Self::new(data.start.0, data.end.0).map_err(D::Error::custom)
    }
}

pub fn frame_step(time: MediaTime, frames: i64, rate: FrameRate) -> Result<MediaTime, AppError> {
    if rate.numerator == 0 || rate.denominator == 0 {
        return Err(AppError::InvalidInput(
            "frame rate numerator and denominator must be non-zero".into(),
        ));
    }

    if frames == 0 {
        return Ok(time);
    }

    let frame_scale = i128::from(rate.denominator)
        .checked_mul(MICROSECONDS_PER_SECOND)
        .ok_or_else(|| AppError::InvalidInput("frame rate overflow".into()))?;
    let scaled_frames = i128::from(frames)
        .checked_mul(frame_scale)
        .ok_or_else(|| AppError::InvalidInput("frame step overflow".into()))?;
    let rate_numerator = i128::from(rate.numerator);
    if scaled_frames % rate_numerator == 0 {
        let stepped = i128::from(time.0)
            .checked_add(scaled_frames / rate_numerator)
            .ok_or_else(|| AppError::InvalidInput("media time overflow".into()))?;
        return i64::try_from(stepped).map(MediaTime).map_err(|_| {
            AppError::InvalidInput("media time is outside the supported range".into())
        });
    }

    let current_scaled = i128::from(time.0)
        .checked_mul(rate_numerator)
        .ok_or_else(|| AppError::InvalidInput("media time overflow".into()))?;
    let current_frame = round_div_nearest(current_scaled, frame_scale);
    let target_frame = current_frame
        .checked_add(i128::from(frames))
        .ok_or_else(|| AppError::InvalidInput("frame step overflow".into()))?;
    let target_scaled = target_frame
        .checked_mul(frame_scale)
        .ok_or_else(|| AppError::InvalidInput("frame step overflow".into()))?;
    let stepped = round_div_nearest(target_scaled, rate_numerator);
    let stepped = i64::try_from(stepped)
        .map_err(|_| AppError::InvalidInput("media time is outside the supported range".into()))?;

    Ok(MediaTime(stepped))
}

fn round_div_nearest(numerator: i128, denominator: i128) -> i128 {
    let quotient = numerator.div_euclid(denominator);
    let remainder = numerator.rem_euclid(denominator);
    if remainder * 2 >= denominator {
        quotient + 1
    } else {
        quotient
    }
}
