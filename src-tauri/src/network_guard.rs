use serde::{Deserialize, Serialize};
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use url::{Host, Url};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkOrigin {
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

impl NetworkOrigin {
    pub fn from_url(url: &Url) -> Result<Self, NetworkGuardError> {
        let scheme = url.scheme().to_ascii_lowercase();
        let host = normalized_host(url)?;
        let port = url.port_or_known_default().ok_or_else(|| {
            NetworkGuardError::InvalidUrl("URL has no effective port".to_string())
        })?;
        Ok(Self { scheme, host, port })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkGrant {
    pub allowed_origins: Vec<NetworkOrigin>,
    #[serde(default)]
    pub allow_authorization: bool,
    #[serde(default)]
    address_policy: NetworkAddressPolicy,
    #[serde(default)]
    allow_proxy_virtual_dns: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum NetworkAddressPolicy {
    #[default]
    PublicOnly,
    ExplicitLocal,
}

impl NetworkGrant {
    pub fn from_urls<'a>(
        urls: impl IntoIterator<Item = &'a str>,
        allow_authorization: bool,
    ) -> Result<Self, NetworkGuardError> {
        let mut allowed_origins = Vec::new();
        for raw in urls {
            let url = validate_network_url(raw)?;
            let origin = NetworkOrigin::from_url(&url)?;
            if !allowed_origins.contains(&origin) {
                allowed_origins.push(origin);
            }
        }
        if allowed_origins.is_empty() {
            return Err(NetworkGuardError::EmptyGrant);
        }
        Ok(Self {
            allowed_origins,
            allow_authorization,
            address_policy: NetworkAddressPolicy::PublicOnly,
            allow_proxy_virtual_dns: false,
        })
    }

    /// Grant a user-configured public provider origin while accepting DNS
    /// answers from the RFC 2544 benchmark range used by system proxy/TUN
    /// clients as virtual "fake IP" destinations. Only a configured hostname
    /// receives that DNS exception; an IP-literal 198.18.0.0/15 target remains
    /// forbidden, while ordinary public IP literals retain their old behavior.
    pub fn for_user_configured_public_origin(
        raw: &str,
        allow_authorization: bool,
    ) -> Result<Self, NetworkGuardError> {
        let url = validate_network_url(raw)?;
        let allow_proxy_virtual_dns = matches!(url.host(), Some(Host::Domain(_)));
        Ok(Self {
            allowed_origins: vec![NetworkOrigin::from_url(&url)?],
            allow_authorization,
            address_policy: NetworkAddressPolicy::PublicOnly,
            allow_proxy_virtual_dns,
        })
    }

    /// Grant one exact provider/MCP origin access to a user-configured local
    /// endpoint. Metadata, link-local, multicast, and unspecified addresses
    /// remain forbidden; the exception is never inferred from response data.
    pub fn for_explicit_local_origin(
        raw: &str,
        allow_authorization: bool,
    ) -> Result<Self, NetworkGuardError> {
        let url = validate_network_url_for_policy(raw, NetworkAddressPolicy::ExplicitLocal)?;
        if !is_explicit_local_url_shape(&url) {
            return Err(NetworkGuardError::ForbiddenHost(normalized_host(&url)?));
        }
        Ok(Self {
            allowed_origins: vec![NetworkOrigin::from_url(&url)?],
            allow_authorization,
            address_policy: NetworkAddressPolicy::ExplicitLocal,
            allow_proxy_virtual_dns: false,
        })
    }

    pub fn allows_proxy_virtual_dns(&self) -> bool {
        self.allow_proxy_virtual_dns
    }

    pub fn authorize_url(&self, raw: &str) -> Result<AuthorizedNetworkTarget, NetworkGuardError> {
        let url = validate_network_url_for_policy(raw, self.address_policy)?;
        let origin = NetworkOrigin::from_url(&url)?;
        if !self.allowed_origins.contains(&origin) {
            return Err(NetworkGuardError::OriginNotGranted(origin));
        }
        Ok(AuthorizedNetworkTarget {
            url,
            origin,
            address_policy: self.address_policy,
            allow_proxy_virtual_dns: self.allow_proxy_virtual_dns,
        })
    }

    /// Validate a redirect target as a fresh network hop. Authorization is
    /// forwarded only when both URLs have the exact same normalized origin.
    pub fn authorize_redirect(
        &self,
        previous: &AuthorizedNetworkTarget,
        redirect_url: &str,
    ) -> Result<RedirectAuthorization, NetworkGuardError> {
        let target = self.authorize_url(redirect_url)?;
        Ok(RedirectAuthorization {
            forward_authorization: self.allow_authorization && previous.origin == target.origin,
            target,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizedNetworkTarget {
    pub url: Url,
    pub origin: NetworkOrigin,
    address_policy: NetworkAddressPolicy,
    allow_proxy_virtual_dns: bool,
}

impl AuthorizedNetworkTarget {
    /// DNS results must be checked immediately before connect. An empty result
    /// fails closed; every address must be public to prevent mixed-answer and
    /// rebinding bypasses.
    pub fn validate_resolved_addresses(
        &self,
        addresses: &[IpAddr],
    ) -> Result<(), NetworkGuardError> {
        validate_resolved_addresses_for_policy(
            addresses,
            self.address_policy,
            self.allow_proxy_virtual_dns,
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedirectAuthorization {
    pub target: AuthorizedNetworkTarget,
    pub forward_authorization: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NetworkGuardError {
    InvalidUrl(String),
    UnsupportedScheme(String),
    CredentialsNotAllowed,
    MissingHost,
    ForbiddenHost(String),
    ForbiddenAddress(IpAddr),
    EmptyResolution,
    EmptyGrant,
    OriginNotGranted(NetworkOrigin),
}

impl fmt::Display for NetworkGuardError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUrl(message) => write!(formatter, "invalid network URL: {message}"),
            Self::UnsupportedScheme(scheme) => {
                write!(formatter, "network URL scheme is not allowed: {scheme}")
            }
            Self::CredentialsNotAllowed => write!(formatter, "URL credentials are not allowed"),
            Self::MissingHost => write!(formatter, "network URL has no host"),
            Self::ForbiddenHost(host) => write!(formatter, "network host is forbidden: {host}"),
            Self::ForbiddenAddress(address) => {
                write!(formatter, "network address is not public: {address}")
            }
            Self::EmptyResolution => write!(formatter, "network target resolved to no addresses"),
            Self::EmptyGrant => write!(formatter, "network grant contains no origins"),
            Self::OriginNotGranted(origin) => write!(
                formatter,
                "network origin is not granted: {}://{}:{}",
                origin.scheme, origin.host, origin.port
            ),
        }
    }
}

impl std::error::Error for NetworkGuardError {}

pub fn validate_network_url(raw: &str) -> Result<Url, NetworkGuardError> {
    validate_network_url_for_policy(raw, NetworkAddressPolicy::PublicOnly)
}

/// Identify the narrow endpoint shapes eligible for an explicit local-model or
/// local-MCP grant. Public hostnames never gain private-network access merely
/// because DNS returned an internal address.
pub fn is_explicit_local_network_url(raw: &str) -> bool {
    let Ok(url) = validate_network_url_for_policy(raw, NetworkAddressPolicy::ExplicitLocal) else {
        return false;
    };
    is_explicit_local_url_shape(&url)
}

fn is_explicit_local_url_shape(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(address)) => address.is_loopback() || address.is_private(),
        Some(Host::Ipv6(address)) => address.is_loopback() || is_ipv6_unique_local(address),
        Some(Host::Domain(host)) => {
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            host == "localhost"
                || host.ends_with(".localhost")
                || host.ends_with(".local")
                || host.ends_with(".lan")
        }
        None => false,
    }
}

fn validate_network_url_for_policy(
    raw: &str,
    policy: NetworkAddressPolicy,
) -> Result<Url, NetworkGuardError> {
    let trimmed = raw.trim();
    let url =
        Url::parse(trimmed).map_err(|error| NetworkGuardError::InvalidUrl(error.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(NetworkGuardError::UnsupportedScheme(
            url.scheme().to_string(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(NetworkGuardError::CredentialsNotAllowed);
    }
    if url.host().is_none() {
        return Err(NetworkGuardError::MissingHost);
    }

    let host = normalized_host(&url)?;
    if is_forbidden_hostname(&host, policy) {
        return Err(NetworkGuardError::ForbiddenHost(host));
    }
    match url.host() {
        Some(Host::Ipv4(address)) if is_forbidden_ip_for_policy(IpAddr::V4(address), policy) => {
            Err(NetworkGuardError::ForbiddenAddress(IpAddr::V4(address)))
        }
        Some(Host::Ipv6(address)) if is_forbidden_ip_for_policy(IpAddr::V6(address), policy) => {
            Err(NetworkGuardError::ForbiddenAddress(IpAddr::V6(address)))
        }
        _ => Ok(url),
    }
}

pub fn validate_resolved_addresses(addresses: &[IpAddr]) -> Result<(), NetworkGuardError> {
    validate_resolved_addresses_for_policy(addresses, NetworkAddressPolicy::PublicOnly, false)
}

fn validate_resolved_addresses_for_policy(
    addresses: &[IpAddr],
    policy: NetworkAddressPolicy,
    allow_proxy_virtual_dns: bool,
) -> Result<(), NetworkGuardError> {
    if addresses.is_empty() {
        return Err(NetworkGuardError::EmptyResolution);
    }
    for address in addresses {
        if is_forbidden_ip_for_policy(*address, policy)
            && !(allow_proxy_virtual_dns && is_proxy_virtual_dns_address(*address))
        {
            return Err(NetworkGuardError::ForbiddenAddress(*address));
        }
    }
    Ok(())
}

pub fn is_forbidden_ip(address: IpAddr) -> bool {
    is_forbidden_ip_for_policy(address, NetworkAddressPolicy::PublicOnly)
}

fn is_forbidden_ip_for_policy(address: IpAddr, policy: NetworkAddressPolicy) -> bool {
    if policy == NetworkAddressPolicy::ExplicitLocal {
        return is_forbidden_explicit_local_ip(address);
    }
    match address {
        IpAddr::V4(address) => is_forbidden_ipv4(address),
        IpAddr::V6(address) => {
            if let Some(mapped) = address.to_ipv4_mapped() {
                return is_forbidden_ipv4(mapped);
            }
            address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || is_ipv6_unique_local(address)
                || is_ipv6_link_local(address)
                || address == "fd00:ec2::254".parse::<Ipv6Addr>().expect("metadata IPv6")
        }
    }
}

fn is_forbidden_explicit_local_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_unspecified()
                || address.is_multicast()
                || address.is_broadcast()
                || address.is_link_local()
                || address == Ipv4Addr::new(169, 254, 169, 254)
                || address == Ipv4Addr::new(100, 100, 100, 200)
        }
        IpAddr::V6(address) => {
            if let Some(mapped) = address.to_ipv4_mapped() {
                return is_forbidden_explicit_local_ip(IpAddr::V4(mapped));
            }
            address.is_unspecified()
                || address.is_multicast()
                || is_ipv6_link_local(address)
                || address == "fd00:ec2::254".parse::<Ipv6Addr>().expect("metadata IPv6")
        }
    }
}

fn normalized_host(url: &Url) -> Result<String, NetworkGuardError> {
    let host = url.host_str().ok_or(NetworkGuardError::MissingHost)?;
    Ok(host.trim_end_matches('.').to_ascii_lowercase())
}

fn is_forbidden_hostname(host: &str, policy: NetworkAddressPolicy) -> bool {
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    let local_host = normalized == "localhost"
        || normalized.ends_with(".localhost")
        || normalized == "localhost.localdomain";
    (policy == NetworkAddressPolicy::PublicOnly && local_host)
        || normalized == "metadata"
        || normalized == "metadata.google.internal"
        || normalized == "metadata.azure.internal"
        || normalized == "instance-data"
        || normalized.ends_with(".internal") && normalized.starts_with("metadata.")
}

fn is_forbidden_ipv4(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_unspecified()
        || address.is_multicast()
        || address.is_broadcast()
        || octets[0] == 0
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
        || address == Ipv4Addr::new(169, 254, 169, 254)
        || address == Ipv4Addr::new(100, 100, 100, 200)
}

fn is_proxy_virtual_dns_address(address: IpAddr) -> bool {
    let address = match address {
        IpAddr::V4(address) => address,
        IpAddr::V6(address) => {
            let Some(address) = address.to_ipv4_mapped() else {
                return false;
            };
            address
        }
    };
    let octets = address.octets();
    octets[0] == 198 && matches!(octets[1], 18 | 19)
}

fn is_ipv6_unique_local(address: Ipv6Addr) -> bool {
    address.segments()[0] & 0xfe00 == 0xfc00
}

fn is_ipv6_link_local(address: Ipv6Addr) -> bool {
    address.segments()[0] & 0xffc0 == 0xfe80
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_validation_allows_only_credential_free_public_http_urls() {
        assert!(validate_network_url("https://example.com/path?q=1").is_ok());
        for raw in [
            "file:///etc/passwd",
            "ftp://example.com/file",
            "https://user:secret@example.com/",
            "http://localhost/admin",
            "http://localhost./admin",
            "http://metadata.google.internal/computeMetadata/v1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.100.100.200/latest/meta-data/",
            "http://10.0.0.1/private",
            "http://[::1]/private",
            "http://[fd00::1]/private",
            "http://[fe80::1]/private",
        ] {
            assert!(validate_network_url(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn dns_answers_fail_closed_on_any_private_or_metadata_address() {
        let public: IpAddr = "93.184.216.34".parse().unwrap();
        let private: IpAddr = "192.168.1.10".parse().unwrap();
        assert!(validate_resolved_addresses(&[public]).is_ok());
        assert!(matches!(
            validate_resolved_addresses(&[]),
            Err(NetworkGuardError::EmptyResolution)
        ));
        assert!(matches!(
            validate_resolved_addresses(&[public, private]),
            Err(NetworkGuardError::ForbiddenAddress(address)) if address == private
        ));
    }

    #[test]
    fn every_redirect_is_revalidated_and_cross_origin_auth_is_stripped() {
        let grant = NetworkGrant::from_urls(
            [
                "https://api.example.com/v1",
                "https://cdn.example.com/assets",
            ],
            true,
        )
        .unwrap();
        let initial = grant
            .authorize_url("https://api.example.com/v1/models")
            .unwrap();
        let same_origin = grant
            .authorize_redirect(&initial, "https://api.example.com/v1/next")
            .unwrap();
        assert!(same_origin.forward_authorization);
        let cross_origin = grant
            .authorize_redirect(&initial, "https://cdn.example.com/assets/model")
            .unwrap();
        assert!(!cross_origin.forward_authorization);

        assert!(grant
            .authorize_redirect(&initial, "http://127.0.0.1/steal")
            .is_err());
        assert!(grant
            .authorize_redirect(&initial, "https://ungranted.example.net/steal")
            .is_err());
    }

    #[test]
    fn normalized_origin_includes_scheme_and_effective_port() {
        let grant = NetworkGrant::from_urls(["https://example.com/start"], false).unwrap();
        assert!(grant.authorize_url("https://example.com:443/next").is_ok());
        assert!(matches!(
            grant.authorize_url("http://example.com/next"),
            Err(NetworkGuardError::OriginNotGranted(_))
        ));
        assert!(matches!(
            grant.authorize_url("https://example.com:444/next"),
            Err(NetworkGuardError::OriginNotGranted(_))
        ));
    }

    #[test]
    fn explicit_local_grant_keeps_model_endpoints_without_opening_metadata() {
        for raw in [
            "http://127.0.0.1:11434/v1",
            "http://localhost:1234/v1",
            "http://192.168.1.20:8080/v1",
        ] {
            let grant = NetworkGrant::for_explicit_local_origin(raw, true).unwrap();
            let target = grant.authorize_url(raw).unwrap();
            let address: IpAddr = if raw.contains("192.168") {
                "192.168.1.20".parse().unwrap()
            } else {
                "127.0.0.1".parse().unwrap()
            };
            target.validate_resolved_addresses(&[address]).unwrap();
        }
        assert!(NetworkGrant::for_explicit_local_origin(
            "http://169.254.169.254/latest/meta-data/",
            true,
        )
        .is_err());
        assert!(NetworkGrant::for_explicit_local_origin(
            "http://metadata.google.internal/computeMetadata/v1/",
            true,
        )
        .is_err());
        assert!(is_explicit_local_network_url("http://localhost:11434/v1"));
        assert!(is_explicit_local_network_url("http://192.168.1.20:8080/v1"));
        assert!(!is_explicit_local_network_url("https://api.openai.com/v1"));
        assert!(
            NetworkGrant::for_explicit_local_origin("https://api.openai.com/v1", true,).is_err()
        );
    }

    #[test]
    fn user_configured_provider_grant_accepts_proxy_virtual_dns_without_opening_private_targets() {
        let grant = NetworkGrant::for_user_configured_public_origin(
            "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
            true,
        )
        .unwrap();
        let target = grant
            .authorize_url("https://dashscope.aliyuncs.com/compatible-mode/v1/models")
            .unwrap();
        let proxy_virtual: IpAddr = "198.18.0.205".parse().unwrap();
        target
            .validate_resolved_addresses(&[proxy_virtual])
            .unwrap();

        let private: IpAddr = "192.168.1.20".parse().unwrap();
        assert!(matches!(
            target.validate_resolved_addresses(&[private]),
            Err(NetworkGuardError::ForbiddenAddress(address)) if address == private
        ));
        assert!(NetworkGrant::for_user_configured_public_origin(
            "http://198.18.0.205/v1/models",
            true,
        )
        .is_err());
        assert!(NetworkGrant::for_user_configured_public_origin(
            "http://127.0.0.1:11434/v1/models",
            true,
        )
        .is_err());
        assert!(NetworkGrant::for_user_configured_public_origin(
            "https://93.184.216.34/v1/models",
            true,
        )
        .is_ok());
    }
}
