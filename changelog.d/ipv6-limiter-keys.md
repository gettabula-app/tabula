section: Security
audience: user

- Rate limits now count an IPv6 client by its /64 prefix, so rotating through addresses of one network no longer gives a fresh limit. People on one IPv6 /64 share a limit; IPv4 is unchanged. Displayed and logged addresses and the source policy still use the exact address.
