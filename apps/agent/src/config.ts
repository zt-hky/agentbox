export const SOCKET_PATH = process.env.AGENTBOX_AGENT_SOCKET ?? "/run/agentbox/agent.sock";
export const CP_USER = "abx-cp";
export const BUILD_USER = "abx-build";

export const TENANTS_DIR = "/srv/agentbox/tenants";
export const ROOTFS_DIR = "/srv/agentbox/rootfs";
export const STORAGE_MOUNT = "/srv/agentbox";
export const BUILD_HOME = "/var/lib/agentbox-build";
export const BUILD_LOG_DIR = `${BUILD_HOME}/logs`;
export const TRIVY_CACHE_DIR = `${BUILD_HOME}/trivy-cache`;
export const BUILD_CONTEXT = "/opt/agentbox/images/workspace";
export const IMAGE_REPO = "localhost/agentbox-workspace";
export const TRIVY_IMAGE =
  "docker.io/aquasec/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c";

export const EXTRA_BLOCKED_CONF = "/etc/agentbox/extra-blocked.conf";
export const MANAGED_IP_FILE = "/var/lib/agentbox/public-ip.txt";
export const PUBLIC_IP_URL = "https://1.1.1.1/cdn-cgi/trace";
export const FIREWALL_SYNC_MS = 10 * 60_000;

export const CONTAINER_NAME = "abx-ws";
export const STOP_TIMEOUT_SEC = 20;
export const HEALTH_TIMEOUT_MS = 60_000;
export const CMD_TIMEOUT_MS = 110_000;
export const BUILD_TIMEOUT_MS = 2 * 60 * 60_000;

export const TENANT_UID_BASE = 200000;
export const MAX_BODY_BYTES = 64 * 1024;
