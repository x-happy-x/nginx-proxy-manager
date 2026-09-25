// Package access holds the router-owned application policy. Account supplies
// identity and the HomeNet administrator role; individual grants live here.
package access

import (
	"encoding/json"
	"os"
)

type Rule struct {
	Mode      string   `json:"mode"`
	Users     []string `json:"users"`
	IPURL     string   `json:"ip_url,omitempty"`
	DomainURL string   `json:"domain_url,omitempty"`
}
type Config struct {
	Apps map[string]Rule `json:"apps"`
}

func Path() string {
	if p := os.Getenv("HOMENET_ACCESS_PATH"); p != "" {
		return p
	}
	return "/opt/etc/homenet/access.json"
}
func Load() (Config, error) {
	c := Config{Apps: map[string]Rule{}}
	b, e := os.ReadFile(Path())
	if os.IsNotExist(e) {
		return c, nil
	}
	if e != nil {
		return c, e
	}
	e = json.Unmarshal(b, &c)
	return c, e
}
func Allowed(rule Rule, login, role string) bool {
	if role == "admin" || rule.Mode == "public" {
		return true
	}
	if rule.Mode == "users" && login != "" {
		for _, u := range rule.Users {
			if u == login {
				return true
			}
		}
	}
	return false
}
