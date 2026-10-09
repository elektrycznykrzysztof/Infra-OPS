export const env = (name: string, fallback = "") => process.env[name]?.trim() || fallback;
export const flag = (name: string) => env(name).toLowerCase() === "true";

export const config = {
  host: env("HOST", "0.0.0.0"),
  port: Number(env("PORT", "3011")),
  origins: env("WEB_ORIGINS", "http://127.0.0.1:3011,http://localhost:3011").split(",").map((v) => v.trim()).filter(Boolean),
  auth: { username: env("APP_USERNAME"), password: env("APP_PASSWORD") },
  veeam: {
    baseUrl: env("VEEAM_BASE_URL"), username: env("VEEAM_USERNAME"), password: env("VEEAM_PASSWORD"),
    version: env("VEEAM_API_VERSION", "1.3-rev1"), insecure: flag("VEEAM_ALLOW_SELF_SIGNED")
  },
  veeamOne: {
    baseUrl: env("VEEAM_ONE_BASE_URL"), username: env("VEEAM_ONE_USERNAME"), password: env("VEEAM_ONE_PASSWORD"),
    version: env("VEEAM_ONE_API_VERSION", "2.3"), insecure: flag("VEEAM_ONE_ALLOW_SELF_SIGNED")
  },
  vcenter: {
    baseUrl: env("VCENTER_BASE_URL"), username: env("VCENTER_USERNAME"), password: env("VCENTER_PASSWORD"),
    apiPath: env("VCENTER_API_BASE_PATH", "/api"), insecure: flag("VCENTER_ALLOW_SELF_SIGNED")
  },
  sophos: {
    baseUrl: env("SOPHOS_BASE_URL"), username: env("SOPHOS_USERNAME"), password: env("SOPHOS_PASSWORD"),
    version: env("SOPHOS_API_VERSION", "2105.1"), insecure: flag("SOPHOS_ALLOW_SELF_SIGNED"),
    webAdminBaseUrl: env("SOPHOS_WEBADMIN_BASE_URL", env("SOPHOS_BASE_URL")),
    webAdminUsername: env("SOPHOS_WEBADMIN_USERNAME", env("SOPHOS_USERNAME")),
    webAdminPassword: env("SOPHOS_WEBADMIN_PASSWORD", env("SOPHOS_PASSWORD")),
    webAdminCredentialsExplicit: Boolean(env("SOPHOS_WEBADMIN_USERNAME") && env("SOPHOS_WEBADMIN_PASSWORD")),
    webAdminInsecure: process.env.SOPHOS_WEBADMIN_ALLOW_SELF_SIGNED?.trim()
      ? flag("SOPHOS_WEBADMIN_ALLOW_SELF_SIGNED")
      : flag("SOPHOS_ALLOW_SELF_SIGNED")
  },
  netapp: {
    username: env("NETAPP_USERNAME"), password: env("NETAPP_PASSWORD"), insecure: flag("NETAPP_ALLOW_SELF_SIGNED"),
    clusters: Array.from({ length: 100 }, (_, i) => ({
      name: env(`NETAPP_CLUSTER_${i + 1}_NAME`), url: env(`NETAPP_CLUSTER_${i + 1}_URL`)
    })).filter((c) => c.name && c.url)
  }
};

export type IntegrationKey = "veeam" | "veeamOne" | "vcenter" | "sophos" | "netapp";
export const configured = (key: IntegrationKey) => {
  if (key === "netapp") return Boolean(config.netapp.username && config.netapp.password && config.netapp.clusters.length);
  const item = config[key];
  return Boolean(item.baseUrl && item.username && item.password);
};

export const fetchOptions = (insecure: boolean) => insecure ? ({ tls: { rejectUnauthorized: false } } as any) : {};
