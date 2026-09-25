package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Minimal RouterOS API client (TCP 8728): enough to read resources and run
// /ping and /tool/fetch on the MikroTik. Credentials come from a KEY=VALUE
// file outside the release (MIKROTIK_CREDENTIALS_FILE), never from runtime.env.

type rosCredentials struct {
	Address  string
	User     string
	Password string
}

func readROSCredentials(path string) (rosCredentials, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return rosCredentials{}, fmt.Errorf("нет доступа к MikroTik (%s): %w", path, err)
	}
	creds := rosCredentials{Address: "192.168.188.1:8728"}
	for _, line := range strings.Split(string(raw), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok || strings.HasPrefix(key, "#") {
			continue
		}
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		switch strings.TrimSpace(key) {
		case "MIKROTIK_ADDRESS":
			creds.Address = value
		case "MIKROTIK_USER":
			creds.User = value
		case "MIKROTIK_PASSWORD":
			creds.Password = value
		}
	}
	if creds.User == "" {
		return creds, fmt.Errorf("в %s не задан MIKROTIK_USER", path)
	}
	return creds, nil
}

type rosConn struct {
	conn net.Conn
	r    *bufio.Reader
	mu   sync.Mutex
}

// rosReply is one command's answer: every !re row plus the !done attributes.
type rosReply struct {
	Rows []map[string]string
	Done map[string]string
}

type rosTrap struct{ Message string }

func (e *rosTrap) Error() string { return e.Message }

func dialROS(creds rosCredentials, timeout time.Duration) (*rosConn, error) {
	conn, err := net.DialTimeout("tcp", creds.Address, timeout)
	if err != nil {
		return nil, err
	}
	c := &rosConn{conn: conn, r: bufio.NewReader(conn)}
	if _, err := c.run(timeout, "/login", "=name="+creds.User, "=password="+creds.Password); err != nil {
		conn.Close()
		return nil, fmt.Errorf("вход в MikroTik: %w", err)
	}
	return c, nil
}

func (c *rosConn) Close() error { return c.conn.Close() }

// Run sends one command and waits for !done, with a deadline for the whole
// exchange (a /tool/fetch or /ping may legitimately take several seconds).
func (c *rosConn) Run(timeout time.Duration, words ...string) (rosReply, error) {
	return c.run(timeout, words...)
}

func (c *rosConn) run(timeout time.Duration, words ...string) (rosReply, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.SetDeadline(time.Now().Add(timeout))
	if err := c.writeSentence(words); err != nil {
		return rosReply{}, err
	}
	reply := rosReply{}
	var trap error
	for {
		sentence, err := c.readSentence()
		if err != nil {
			return reply, err
		}
		if len(sentence) == 0 {
			continue
		}
		attrs := map[string]string{}
		for _, word := range sentence[1:] {
			if strings.HasPrefix(word, "=") {
				key, value, _ := strings.Cut(word[1:], "=")
				attrs[key] = value
			}
		}
		switch sentence[0] {
		case "!re":
			reply.Rows = append(reply.Rows, attrs)
		case "!trap":
			trap = &rosTrap{Message: attrs["message"]}
		case "!fatal":
			return reply, errors.New("MikroTik закрыл сессию: " + strings.Join(sentence[1:], " "))
		case "!done":
			reply.Done = attrs
			return reply, trap
		}
	}
}

func (c *rosConn) writeSentence(words []string) error {
	var buf []byte
	for _, word := range words {
		buf = appendROSLength(buf, len(word))
		buf = append(buf, word...)
	}
	buf = append(buf, 0)
	_, err := c.conn.Write(buf)
	return err
}

func appendROSLength(buf []byte, n int) []byte {
	switch {
	case n < 0x80:
		return append(buf, byte(n))
	case n < 0x4000:
		return append(buf, byte(n>>8|0x80), byte(n))
	case n < 0x200000:
		return append(buf, byte(n>>16|0xC0), byte(n>>8), byte(n))
	case n < 0x10000000:
		return append(buf, byte(n>>24|0xE0), byte(n>>16), byte(n>>8), byte(n))
	}
	return append(buf, 0xF0, byte(n>>24), byte(n>>16), byte(n>>8), byte(n))
}

func (c *rosConn) readSentence() ([]string, error) {
	var words []string
	for {
		n, err := c.readLength()
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return words, nil
		}
		word := make([]byte, n)
		if _, err := io.ReadFull(c.r, word); err != nil {
			return nil, err
		}
		words = append(words, string(word))
	}
}

func (c *rosConn) readLength() (int, error) {
	first, err := c.r.ReadByte()
	if err != nil {
		return 0, err
	}
	extra := 0
	value := int(first)
	switch {
	case first&0x80 == 0:
		return value, nil
	case first&0xC0 == 0x80:
		extra, value = 1, value&0x3F
	case first&0xE0 == 0xC0:
		extra, value = 2, value&0x1F
	case first&0xF0 == 0xE0:
		extra, value = 3, value&0x0F
	default:
		extra, value = 4, 0
	}
	for i := 0; i < extra; i++ {
		b, err := c.r.ReadByte()
		if err != nil {
			return 0, err
		}
		value = value<<8 | int(b)
	}
	return value, nil
}

// parseROSDuration reads RouterOS durations: "3w2d4h5m6s", "12ms", "1s250ms",
// "00:01:02" and plain seconds. Returns seconds.
func parseROSDuration(value string) float64 {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if strings.Count(value, ":") == 2 {
		parts := strings.Split(value, ":")
		h, _ := strconv.ParseFloat(parts[0], 64)
		m, _ := strconv.ParseFloat(parts[1], 64)
		s, _ := strconv.ParseFloat(parts[2], 64)
		return h*3600 + m*60 + s
	}
	units := []struct {
		suffix string
		scale  float64
	}{{"ms", 0.001}, {"us", 0.000001}, {"ns", 1e-9}, {"w", 7 * 86400}, {"d", 86400}, {"h", 3600}, {"m", 60}, {"s", 1}}
	total, number := 0.0, ""
	for i := 0; i < len(value); {
		ch := value[i]
		if (ch >= '0' && ch <= '9') || ch == '.' {
			number += string(ch)
			i++
			continue
		}
		matched := false
		for _, unit := range units {
			if strings.HasPrefix(value[i:], unit.suffix) {
				n, _ := strconv.ParseFloat(number, 64)
				total += n * unit.scale
				number, i, matched = "", i+len(unit.suffix), true
				break
			}
		}
		if !matched {
			i++
		}
	}
	if number != "" {
		n, _ := strconv.ParseFloat(number, 64)
		total += n
	}
	return total
}

func rosInt(value string) int64 {
	value = strings.TrimSpace(value)
	end := 0
	for end < len(value) && (value[end] == '-' || value[end] == '.' || (value[end] >= '0' && value[end] <= '9')) {
		end++
	}
	f, _ := strconv.ParseFloat(value[:end], 64)
	return int64(f)
}
