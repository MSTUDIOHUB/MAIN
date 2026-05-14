use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::time::sleep;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    pub max_attempts: usize,
    pub backoff_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryState {
    pub attempts: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetryDecision {
    Retry { attempt: usize },
    Stop,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 2,
            backoff_ms: 250,
        }
    }
}

impl RetryPolicy {
    pub fn new(max_attempts: usize, backoff_ms: u64) -> Self {
        Self {
            max_attempts,
            backoff_ms,
        }
    }

    pub async fn handle(&self, state: &mut RetryState) -> RetryDecision {
        if state.attempts >= self.max_attempts {
            return RetryDecision::Stop;
        }

        state.attempts += 1;
        if self.backoff_ms > 0 {
            sleep(Duration::from_millis(self.backoff_ms)).await;
        }
        RetryDecision::Retry {
            attempt: state.attempts,
        }
    }
}

impl RetryState {
    pub fn new() -> Self {
        Self { attempts: 0 }
    }
}

#[cfg(test)]
mod tests {
    use super::{RetryDecision, RetryPolicy, RetryState};

    #[test]
    fn retry_policy_stops_after_max_attempts() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let policy = RetryPolicy::new(1, 0);
            let mut state = RetryState::new();

            assert_eq!(
                policy.handle(&mut state).await,
                RetryDecision::Retry { attempt: 1 }
            );
            assert_eq!(policy.handle(&mut state).await, RetryDecision::Stop);
        });
    }
}
