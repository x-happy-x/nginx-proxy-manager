package main

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// LTE antenna tools: a live reading for aiming (signal, cell, carrier
// aggregation, throughput), a short download on the MikroTik so the network
// actually switches aggregation on, and a band survey that locks the modem to
// one band at a time to see which cells exist around. The survey always puts
// the band setting back; a one-shot RouterOS scheduler does the same after
// 15 minutes in case the manager dies mid-survey.

const (
	lteIface          = "lte1"
	lteRestoreJob     = "homenet-lte-band-restore"
	lteLoadURL        = "https://speed.cloudflare.com/__down?bytes=1000000000"
	lteSurveyAttach   = 35 * time.Second
	lteSurveyListen   = 6 * time.Second
	lteRestoreTimeout = 15 * time.Minute
)

type lteCarrier struct {
	Role     string  `json:"role"` // pcc | scc
	Band     string  `json:"band"`
	EARFCN   int     `json:"earfcn"`
	WidthMHz float64 `json:"width_mhz"`
	PCI      int     `json:"pci"`
	Active   bool    `json:"active"`
	RSRP     int     `json:"rsrp"`
	RSRQ     int     `json:"rsrq"`
	SINR     int     `json:"sinr"`
}

type lteLive struct {
	At       int64        `json:"at"`
	Status   string       `json:"status"`
	Operator string       `json:"operator"`
	Band     string       `json:"band"`
	EARFCN   int          `json:"earfcn"`
	PCI      int          `json:"pci"`
	CellID   string       `json:"cell_id"`
	ENB      string       `json:"enb"`
	Sector   string       `json:"sector"`
	RSRP     int          `json:"rsrp"`
	RSRQ     int          `json:"rsrq"`
	SINR     int          `json:"sinr"`
	RSSI     int          `json:"rssi"`
	CQI      int          `json:"cqi"`
	RI       int          `json:"ri"`
	MCS      int          `json:"mcs"`
	Mod      string       `json:"modulation"`
	Carriers []lteCarrier `json:"carriers"`
	TotalMHz float64      `json:"total_mhz"`
	RxBps    float64      `json:"rx_bps"`
	TxBps    float64      `json:"tx_bps"`
	Neigh    []lteCell    `json:"neighbours"`
	BandLock string       `json:"band_lock"`
}

type lteCell struct {
	Band   string `json:"band"`
	EARFCN int    `json:"earfcn"`
	PCI    int    `json:"pci"`
	RSRP   int    `json:"rsrp"`
	RSRQ   int    `json:"rsrq"`
	RSSI   int    `json:"rssi,omitempty"`
}

type lteSurveyBand struct {
	Band    int       `json:"band"`
	Found   bool      `json:"found"`
	Note    string    `json:"note,omitempty"`
	Serving *lteLive  `json:"serving,omitempty"`
	Cells   []lteCell `json:"cells"`
	Seconds float64   `json:"seconds"`
}

type lteSurvey struct {
	ID       int64           `json:"id"`
	Label    string          `json:"label"`
	Started  int64           `json:"started"`
	Finished int64           `json:"finished,omitempty"`
	Bands    []int           `json:"bands"`
	Results  []lteSurveyBand `json:"results"`
	Current  int             `json:"current,omitempty"` // band being measured
	Error    string          `json:"error,omitempty"`
	Restored bool            `json:"restored"`
}

type lteTools struct {
	mu        sync.Mutex
	loadUntil int64
	loadErr   string
	survey    *lteSurvey
	history   []lteSurvey
	busy      bool // a survey owns the modem
}

var lteTool = &lteTools{}

func lteConn() (*rosConn, error) {
	creds, err := readROSCredentials(getenv("MIKROTIK_CREDENTIALS_FILE", "/opt/etc/homenet/secrets/mikrotik.env"))
	if err != nil {
		return nil, err
	}
	return dialROS(creds, 5*time.Second)
}

var bandNum = regexp.MustCompile(`B(\d+)`)

// rbWidth converts Quectel resource-block counts into MHz.
func rbWidth(rb int) float64 {
	switch rb {
	case 6:
		return 1.4
	case 15:
		return 3
	case 25:
		return 5
	case 50:
		return 10
	case 75:
		return 15
	case 100:
		return 20
	}
	if rb >= 0 && rb <= 5 {
		return []float64{1.4, 3, 5, 10, 15, 20}[rb]
	}
	return 0
}

var qcaLine = regexp.MustCompile(`\+QCAINFO:\s*"(pcc|scc)",(\d+),(\d+),"LTE BAND (\d+)",(\d+),(\d+),(-?\d+),(-?\d+),(-?\d+),(-?\d+)`)

// parseQCAINFO reads Quectel's carrier list (PCC plus configured SCCs).
func parseQCAINFO(out string) []lteCarrier {
	var list []lteCarrier
	for _, m := range qcaLine.FindAllStringSubmatch(out, -1) {
		n := func(i int) int { v, _ := strconv.Atoi(m[i]); return v }
		c := lteCarrier{Role: m[1], EARFCN: n(2), WidthMHz: rbWidth(n(3)), Band: "B" + m[4], PCI: n(6), RSRP: n(7), RSRQ: n(8), SINR: n(10)}
		// pcell_state 1 = serving; scell_state 2 = configured and activated.
		c.Active = (c.Role == "pcc" && n(5) >= 1) || (c.Role == "scc" && n(5) == 2)
		list = append(list, c)
	}
	return list
}

var neighLine = regexp.MustCompile(`\+QENG:\s*"neighbourcell (?:intra|inter)","LTE",(\d+),(\d+),(-?\d+),(-?\d+),(-?\d+)`)

func parseNeighbours(out string) []lteCell {
	var cells []lteCell
	for _, m := range neighLine.FindAllStringSubmatch(out, -1) {
		n := func(i int) int { v, _ := strconv.Atoi(m[i]); return v }
		cells = append(cells, lteCell{EARFCN: n(1), PCI: n(2), RSRQ: n(3), RSRP: n(4), RSSI: n(5), Band: earfcnBand(n(1))})
	}
	return cells
}

// earfcnBand maps a downlink EARFCN to its LTE band (bands the EG18 knows).
func earfcnBand(e int) string {
	ranges := []struct{ lo, hi, band int }{
		{0, 599, 1}, {1200, 1949, 3}, {2400, 2649, 5}, {2750, 3449, 7}, {3450, 3799, 8},
		{6150, 6449, 20}, {9210, 9659, 28}, {37750, 38249, 38}, {38650, 39649, 40}, {39650, 41589, 41},
	}
	for _, r := range ranges {
		if e >= r.lo && e <= r.hi {
			return "B" + strconv.Itoa(r.band)
		}
	}
	return ""
}

func atChat(conn *rosConn, cmd string) string {
	reply, err := conn.Run(6*time.Second, "/interface/lte/at-chat", "=.id="+lteIface, "=input="+cmd)
	if err != nil || len(reply.Rows) == 0 {
		return ""
	}
	return reply.Rows[0]["output"]
}

func readLTELive(conn *rosConn) (*lteLive, error) {
	reply, err := conn.Run(6*time.Second, "/interface/lte/monitor", "=numbers="+lteIface, "=once=")
	if err != nil {
		return nil, err
	}
	if len(reply.Rows) == 0 {
		return nil, errors.New("модем не ответил")
	}
	m := reply.Rows[0]
	live := &lteLive{
		At: time.Now().Unix(), Status: m["status"], Operator: m["current-operator"], CellID: m["current-cellid"],
		ENB: m["enb-id"], Sector: m["sector-id"], Mod: m["dl-modulation"],
		RSRP: int(rosInt(m["rsrp"])), RSRQ: int(rosInt(m["rsrq"])), SINR: int(rosInt(m["sinr"])), RSSI: int(rosInt(m["rssi"])),
		CQI: int(rosInt(m["cqi"])), RI: int(rosInt(m["ri"])), MCS: int(rosInt(m["mcs"])),
		Carriers: []lteCarrier{}, Neigh: []lteCell{},
	}
	// "B3@10Mhz earfcn: 1875 phy-cellid: 357"
	primary := m["primary-band"]
	if f := strings.Fields(primary); len(f) > 0 {
		live.Band = strings.Split(f[0], "@")[0]
	}
	if v := regexp.MustCompile(`earfcn:\s*(\d+)`).FindStringSubmatch(primary); v != nil {
		live.EARFCN, _ = strconv.Atoi(v[1])
	}
	if v := regexp.MustCompile(`phy-cellid:\s*(\d+)`).FindStringSubmatch(primary); v != nil {
		live.PCI, _ = strconv.Atoi(v[1])
	}
	live.Carriers = parseQCAINFO(atChat(conn, "AT+QCAINFO"))
	if len(live.Carriers) == 0 && live.Band != "" {
		width := 0.0
		if v := regexp.MustCompile(`@(\d+(?:\.\d+)?)Mhz`).FindStringSubmatch(primary); v != nil {
			width, _ = strconv.ParseFloat(v[1], 64)
		}
		live.Carriers = []lteCarrier{{Role: "pcc", Band: live.Band, EARFCN: live.EARFCN, WidthMHz: width, PCI: live.PCI, Active: true, RSRP: live.RSRP, RSRQ: live.RSRQ, SINR: live.SINR}}
	}
	// RouterOS also reports secondary carriers itself on some modems.
	for key, value := range m {
		if strings.HasPrefix(key, "ca-band") && value != "" && !hasSCC(live.Carriers) {
			for _, part := range strings.Split(value, ",") {
				if b := bandNum.FindString(part); b != "" {
					live.Carriers = append(live.Carriers, lteCarrier{Role: "scc", Band: b, Active: true})
				}
			}
		}
	}
	for _, c := range live.Carriers {
		if c.Active {
			live.TotalMHz += c.WidthMHz
		}
	}
	live.Neigh = parseNeighbours(atChat(conn, `AT+QENG="neighbourcell"`))
	if t, err := conn.Run(4*time.Second, "/interface/monitor-traffic", "=interface="+lteIface, "=once="); err == nil && len(t.Rows) > 0 {
		live.RxBps = float64(rosInt(t.Rows[0]["rx-bits-per-second"]))
		live.TxBps = float64(rosInt(t.Rows[0]["tx-bits-per-second"]))
	}
	if p, err := conn.Run(4*time.Second, "/interface/lte/print", "=.proplist=name,band"); err == nil {
		for _, row := range p.Rows {
			if row["name"] == lteIface {
				live.BandLock = row["band"]
			}
		}
	}
	return live, nil
}

func hasSCC(list []lteCarrier) bool {
	for _, c := range list {
		if c.Role == "scc" {
			return true
		}
	}
	return false
}

// ---------- load ----------

func (t *lteTools) startLoad(seconds int) error {
	t.mu.Lock()
	if t.busy {
		t.mu.Unlock()
		return errors.New("идёт обзор диапазонов — нагрузка не нужна")
	}
	if t.loadUntil > time.Now().Unix() {
		t.mu.Unlock()
		return nil
	}
	t.loadUntil, t.loadErr = time.Now().Unix()+int64(seconds), ""
	t.mu.Unlock()
	go func() {
		conn, err := lteConn()
		if err == nil {
			// fetch stops by itself when =duration= runs out.
			_, err = conn.Run(time.Duration(seconds+15)*time.Second, "/tool/fetch", "=url="+lteLoadURL, "=output=none", "=check-certificate=no", "=duration="+strconv.Itoa(seconds)+"s")
			conn.Close()
		}
		t.mu.Lock()
		t.loadUntil = 0
		if err != nil && !strings.Contains(err.Error(), "status") {
			t.loadErr = err.Error()
		}
		t.mu.Unlock()
	}()
	return nil
}

// ---------- band survey ----------

func (t *lteTools) startSurvey(bands []int, label string) (*lteSurvey, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.busy {
		return nil, errors.New("обзор уже идёт")
	}
	s := &lteSurvey{ID: time.Now().UnixMilli(), Label: label, Started: time.Now().Unix(), Bands: bands, Results: []lteSurveyBand{}}
	t.survey, t.busy = s, true
	go t.runSurvey(s)
	return s, nil
}

func (t *lteTools) update(fn func(s *lteSurvey)) {
	t.mu.Lock()
	fn(t.survey)
	t.mu.Unlock()
}

func (t *lteTools) runSurvey(s *lteSurvey) {
	defer func() {
		t.mu.Lock()
		s.Finished, s.Current = time.Now().Unix(), 0
		t.history = append([]lteSurvey{*s}, t.history...)
		if len(t.history) > 20 {
			t.history = t.history[:20]
		}
		t.busy = false
		t.mu.Unlock()
	}()
	conn, err := lteConn()
	if err != nil {
		t.update(func(s *lteSurvey) { s.Error = err.Error() })
		return
	}
	defer conn.Close()
	original := ""
	if p, err := conn.Run(4*time.Second, "/interface/lte/print", "=.proplist=name,band"); err == nil {
		for _, row := range p.Rows {
			if row["name"] == lteIface {
				original = row["band"]
			}
		}
	} else {
		t.update(func(s *lteSurvey) {
			s.Error = "не прочитать настройку диапазонов: " + err.Error()
		})
		return
	}
	if err := armRestore(conn, original); err != nil {
		t.update(func(s *lteSurvey) {
			s.Error = "не удалось поставить страховку на MikroTik: " + err.Error()
		})
		return
	}
	restore := func() {
		// A fresh connection: the modem restarts on band changes and the old
		// API session may be stuck waiting.
		for attempt := 0; attempt < 5; attempt++ {
			c, err := lteConn()
			if err == nil {
				_, err = c.Run(8*time.Second, "/interface/lte/set", "=.id="+lteIface, "=band="+original)
				if err == nil {
					disarmRestore(c)
					c.Close()
					t.update(func(s *lteSurvey) { s.Restored = true })
					return
				}
				c.Close()
			}
			time.Sleep(3 * time.Second)
		}
		t.update(func(s *lteSurvey) {
			s.Error = "не удалось вернуть диапазоны — MikroTik вернёт их сам через 15 минут"
		})
	}
	defer restore()

	for _, band := range s.Bands {
		t.update(func(s *lteSurvey) { s.Current = band })
		started := time.Now()
		res := lteSurveyBand{Band: band, Cells: []lteCell{}}
		if _, err := conn.Run(8*time.Second, "/interface/lte/set", "=.id="+lteIface, "=band="+strconv.Itoa(band)); err != nil {
			res.Note = "модем не принял диапазон: " + err.Error()
			t.update(func(s *lteSurvey) { s.Results = append(s.Results, res) })
			continue
		}
		want := "B" + strconv.Itoa(band)
		deadline := time.Now().Add(lteSurveyAttach)
		for time.Now().Before(deadline) {
			time.Sleep(2 * time.Second)
			c, err := lteConn()
			if err != nil {
				continue
			}
			live, err := readLTELive(c)
			c.Close()
			if err == nil && live.Status == "running" && live.Band == want {
				res.Found, res.Serving = true, live
				break
			}
		}
		if res.Found {
			if c, err := lteConn(); err == nil {
				reply, _ := c.Run(lteSurveyListen+5*time.Second, "/interface/lte/cell-monitor", "=.id="+lteIface, "=duration="+strconv.Itoa(int(lteSurveyListen/time.Second))+"s")
				c.Close()
				seen := map[string]lteCell{}
				for _, row := range reply.Rows {
					cell := lteCell{Band: row["band"], EARFCN: int(rosInt(row["earfcn"])), PCI: int(rosInt(row["phy-cellid"])), RSRP: int(rosInt(row["rsrp"])), RSRQ: int(rosInt(row["rsrq"])), RSSI: int(rosInt(row["rssi"]))}
					seen[fmt.Sprintf("%d/%d", cell.EARFCN, cell.PCI)] = cell
				}
				for _, cell := range seen {
					res.Cells = append(res.Cells, cell)
				}
				sort.Slice(res.Cells, func(i, j int) bool { return res.Cells[i].RSRP > res.Cells[j].RSRP })
			}
		} else {
			res.Note = "за " + strconv.Itoa(int(lteSurveyAttach/time.Second)) + " с сеть в этом диапазоне не найдена"
		}
		res.Seconds = round2(time.Since(started).Seconds())
		t.update(func(s *lteSurvey) { s.Results = append(s.Results, res) })
	}
}

// armRestore leaves a one-shot scheduler on the MikroTik that puts the band
// setting back even if the manager never gets to do it.
func armRestore(conn *rosConn, original string) error {
	disarmRestore(conn)
	clock, err := conn.Run(4*time.Second, "/system/clock/print")
	if err != nil || len(clock.Rows) == 0 {
		return fmt.Errorf("нет часов MikroTik: %v", err)
	}
	now, err := time.Parse("2006-01-02 15:04:05", clock.Rows[0]["date"]+" "+clock.Rows[0]["time"])
	if err != nil {
		return err
	}
	at := now.Add(lteRestoreTimeout)
	script := fmt.Sprintf(`/interface lte set %s band="%s"; /system scheduler remove [find name="%s"]`, lteIface, original, lteRestoreJob)
	_, err = conn.Run(5*time.Second, "/system/scheduler/add", "=name="+lteRestoreJob,
		"=start-date="+at.Format("2006-01-02"), "=start-time="+at.Format("15:04:05"), "=interval=0s",
		"=on-event="+script, "=comment=HomeNet: вернуть диапазоны LTE после обзора")
	return err
}

func disarmRestore(conn *rosConn) {
	reply, err := conn.Run(4*time.Second, "/system/scheduler/print", "?name="+lteRestoreJob, "=.proplist=.id")
	if err != nil {
		return
	}
	for _, row := range reply.Rows {
		_, _ = conn.Run(4*time.Second, "/system/scheduler/remove", "=.id="+row[".id"])
	}
}

// ---------- HTTP ----------

func (a *app) handleLTELive(w http.ResponseWriter) {
	lteTool.mu.Lock()
	busy := lteTool.busy
	lteTool.mu.Unlock()
	out := response{"ok": true}
	if !busy {
		conn, err := lteConn()
		if err != nil {
			out["error"] = err.Error()
		} else {
			live, err := readLTELive(conn)
			conn.Close()
			if err != nil {
				out["error"] = err.Error()
			} else {
				out["live"] = live
			}
		}
	}
	lteTool.mu.Lock()
	out["busy"] = lteTool.busy
	out["load_until"] = lteTool.loadUntil
	out["load_error"] = lteTool.loadErr
	if lteTool.survey != nil {
		out["survey"] = *lteTool.survey
	}
	out["history"] = lteTool.history
	lteTool.mu.Unlock()
	a.writeJSON(w, http.StatusOK, out)
}

var surveyBands = map[int]bool{1: true, 3: true, 5: true, 7: true, 8: true, 20: true, 28: true, 38: true, 40: true, 41: true}

func (a *app) handleLTEPost(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/api/network/lte/load":
		var req struct {
			Seconds int `json:"seconds"`
		}
		if !a.decodeJSON(w, r, &req) {
			return
		}
		if req.Seconds < 5 || req.Seconds > 60 {
			req.Seconds = 15
		}
		if err := lteTool.startLoad(req.Seconds); err != nil {
			a.writeJSON(w, http.StatusConflict, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusOK, response{"ok": true})
	case "/api/network/lte/survey":
		var req struct {
			Bands []int  `json:"bands"`
			Label string `json:"label"`
		}
		if !a.decodeJSON(w, r, &req) {
			return
		}
		bands := []int{}
		for _, b := range req.Bands {
			if surveyBands[b] {
				bands = append(bands, b)
			}
		}
		if len(bands) == 0 {
			a.writeJSON(w, http.StatusBadRequest, response{"ok": false, "error": "выберите диапазоны"})
			return
		}
		label := strings.TrimSpace(req.Label)
		if len(label) > 60 {
			label = label[:60]
		}
		s, err := lteTool.startSurvey(bands, label)
		if err != nil {
			a.writeJSON(w, http.StatusConflict, response{"ok": false, "error": err.Error()})
			return
		}
		a.writeJSON(w, http.StatusOK, response{"ok": true, "survey": s})
	default:
		http.NotFound(w, r)
	}
}
