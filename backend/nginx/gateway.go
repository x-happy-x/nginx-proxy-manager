package main

import "fmt"

func gatewayLocations(host string, externalHTTPS bool) string {
	proto := "$scheme"
	if externalHTTPS {
		proto = "https"
	}
	headers := fmt.Sprintf(`    proxy_set_header X-Gate-Host %s;
    proxy_set_header X-Gate-Proto %s;
    proxy_set_header X-Gate-IP $remote_addr;
    proxy_set_header X-Gate-URI $request_uri;
    proxy_set_header Cookie $http_cookie;
    proxy_set_header Origin $http_origin;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Host %s;
    proxy_connect_timeout 2s;
    proxy_read_timeout 12s;
`, host, proto, host)
	return "location = /_gate/check {\n    internal;\n    proxy_pass http://127.0.0.1:63415;\n    proxy_pass_request_body off;\n    proxy_set_header Content-Length \"\";\n" + headers + "}\nlocation ^~ /_gate/ {\n    proxy_pass http://127.0.0.1:63415;\n    client_max_body_size 4k;\n" + headers + "}\n"
}
