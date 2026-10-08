package access

import (
	"fmt"
	"net/url"
)

func Validate(c Config) error {
	if c.Apps == nil || len(c.Apps) > 512 {
		return fmt.Errorf("invalid application list")
	}
	for id, r := range c.Apps {
		if id == "" || (r.Mode != "admin" && r.Mode != "users" && r.Mode != "public") || len(r.Users) > 500 {
			return fmt.Errorf("invalid access rule")
		}
		for _, u := range r.Users {
			if u == "" || len(u) > 128 {
				return fmt.Errorf("invalid login")
			}
		}
		for _, raw := range []string{r.IPURL, r.DomainURL} {
			if raw != "" {
				u, e := url.Parse(raw)
				if e != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
					return fmt.Errorf("invalid link")
				}
			}
		}
	}
	return nil
}
