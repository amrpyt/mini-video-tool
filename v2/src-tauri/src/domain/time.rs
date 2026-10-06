use serde::{Deserialize, Serialize};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeRange {
    pub start: MediaTime,
    pub end: MediaTime,
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
}

pub fn frame_step(time: MediaTime, frames: i64, rate: FrameRate) -> Result<MediaTime, AppError> {
    if rate.numerator == 0 || rate.denominator == 0 {
        return Err(AppError::InvalidInput(
            "frame rate numerator and denominator must be non-zero".into(),
        ));
    }

    let scaled_frames = i128::from(frames)
        .checked_mul(i128::from(rate.denominator))
        .and_then(|value| value.checked_mul(MICROSECONDS_PER_SECOND))
        .ok_or_else(|| AppError::InvalidInput("frame step overflow".into()))?;
    let delta = scaled_frames / i128::from(rate.numerator);
    let stepped = i128::from(time.0)
        .checked_add(delta)
        .ok_or_else(|| AppError::InvalidInput("media time overflow".into()))?;
    let stepped = i64::try_from(stepped)
        .map_err(|_| AppError::InvalidInput("media time is outside the supported range".into()))?;

    Ok(MediaTime(stepped))
}
