use std::thread::sleep;
use std::time::Duration;

#[derive(Debug)]
pub enum HttpError {
    Timeout,
    Status(u16),
    Network(String),
}

pub struct Response {
    pub status: u16,
    pub body: String,
}

pub trait Transport {
    fn send(&self, url: &str) -> Result<Response, HttpError>;
}

pub struct HttpClient<T: Transport> {
    transport: T,
    max_retries: u32,
    base_delay: Duration,
}

impl<T: Transport> HttpClient<T> {
    pub fn new(transport: T) -> Self {
        HttpClient { transport, max_retries: 3, base_delay: Duration::from_millis(100) }
    }

    pub fn with_retries(mut self, max_retries: u32) -> Self {
        self.max_retries = max_retries;
        self
    }

    /// Sends a GET request, retrying with exponential backoff on timeouts and 5xx responses.
    pub fn get_with_retry(&self, url: &str) -> Result<Response, HttpError> {
        let mut attempt = 0;
        loop {
            match self.transport.send(url) {
                Ok(resp) if resp.status < 500 => return Ok(resp),
                Ok(resp) if attempt >= self.max_retries => return Err(HttpError::Status(resp.status)),
                Err(err) if attempt >= self.max_retries => return Err(err),
                _ => {
                    sleep(self.base_delay * 2u32.pow(attempt));
                    attempt += 1;
                }
            }
        }
    }
}
