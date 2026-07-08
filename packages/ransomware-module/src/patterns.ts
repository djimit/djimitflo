import { RiskLevel } from './types';

export interface PatternDefinition {
  pattern: RegExp;
  riskLevel: RiskLevel;
  category: string;
  description: string;
}

export const CRITICAL_PATTERNS: PatternDefinition[] = [
  {
    pattern: /AES_ENCRYPT\s*\(/i,
    riskLevel: 'CRITICAL',
    category: 'encryption',
    description: 'MySQL AES_ENCRYPT function — JADEPUFFER encryption signature'
  },
  {
    pattern: /DROP\s+DATABASE/i,
    riskLevel: 'CRITICAL',
    category: 'destruction',
    description: 'DROP DATABASE — mass destruction command'
  },
  {
    pattern: /DROP\s+TABLE/i,
    riskLevel: 'CRITICAL',
    category: 'destruction',
    description: 'DROP TABLE — table destruction command'
  },
  {
    pattern: /vssadmin.*delete.*shadows/i,
    riskLevel: 'CRITICAL',
    category: 'backup_destruction',
    description: 'Windows shadow copy deletion — prevents recovery'
  },
  {
    pattern: /wbadmin.*delete.*catalog/i,
    riskLevel: 'CRITICAL',
    category: 'backup_destruction',
    description: 'Windows backup catalog deletion'
  },
  {
    pattern: /wmic.*shadowcopy.*delete/i,
    riskLevel: 'CRITICAL',
    category: 'backup_destruction',
    description: 'WMIC shadow copy deletion'
  },
  {
    pattern: /bcdedit.*bootstatuspolicy.*ignoreallfailures/i,
    riskLevel: 'CRITICAL',
    category: 'boot_sabotage',
    description: 'Boot configuration sabotage — prevents recovery'
  },
  {
    pattern: /CREATE\s+FUNCTION.*RETURNS\s+INTEGER\s+SONAME/i,
    riskLevel: 'CRITICAL',
    category: 'udf_escalation',
    description: 'MySQL UDF creation — OS command execution primitive'
  },
  {
    pattern: /CREATE\s+TABLE\s+README_RANSOM/i,
    riskLevel: 'CRITICAL',
    category: 'extortion',
    description: 'Ransom note table creation — extortion behavior'
  },
  {
    pattern: /minioadmin:minioadmin/i,
    riskLevel: 'CRITICAL',
    category: 'default_creds',
    description: 'MinIO default credentials usage — JADEPUFFER credential harvesting'
  }
];

export const HIGH_PATTERNS: PatternDefinition[] = [
  {
    pattern: /gpg.*--encrypt.*--batch/i,
    riskLevel: 'HIGH',
    category: 'encryption',
    description: 'GPG batch encryption — potential mass file encryption'
  },
  {
    pattern: /openssl.*enc.*-aes/i,
    riskLevel: 'HIGH',
    category: 'encryption',
    description: 'OpenSSL AES encryption — potential file encryption'
  },
  {
    pattern: /INTO\s+OUTFILE/i,
    riskLevel: 'HIGH',
    category: 'file_write',
    description: 'MySQL INTO OUTFILE — file write primitive'
  },
  {
    pattern: /LOAD_FILE\s*\(/i,
    riskLevel: 'HIGH',
    category: 'file_read',
    description: 'MySQL LOAD_FILE — file read primitive'
  },
  {
    pattern: /crontab.*-e/i,
    riskLevel: 'HIGH',
    category: 'persistence',
    description: 'Crontab modification — persistence mechanism'
  },
  {
    pattern: /credentials\.json/i,
    riskLevel: 'HIGH',
    category: 'credential_targeting',
    description: 'Credentials file targeting — credential harvesting'
  },
  {
    pattern: /\.env\s*\|\s*base64/i,
    riskLevel: 'HIGH',
    category: 'secret_exfil',
    description: 'Environment file exfiltration'
  },
  {
    pattern: /curl.*--unix-socket.*docker\.sock/i,
    riskLevel: 'HIGH',
    category: 'container_escape',
    description: 'Docker socket access — container escape vector'
  },
  {
    pattern: /SELECT\s+LENGTH\s*\(\s*LOAD_FILE\s*\(\s*[\'\"]\/var\/run\/docker\.sock[\'\"]\s*\)\s*\)/i,
    riskLevel: 'HIGH',
    category: 'container_escape_recon',
    description: 'Docker socket readability probe — container escape pre-check'
  },
  {
    pattern: /SELECT\s+LOAD_FILE\s*\(\s*[\'\"]\/proc\/1\/cgroup[\'\"]\s*\)/i,
    riskLevel: 'HIGH',
    category: 'container_escape_recon',
    description: 'cgroup readability probe — container escape pre-check'
  },
  {
    pattern: /terraform-state/i,
    riskLevel: 'HIGH',
    category: 'credential_targeting',
    description: 'Terraform state bucket access — infrastructure credential theft'
  },
  {
    pattern: /3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy/,
    riskLevel: 'HIGH',
    category: 'ransom_address',
    description: 'JADEPUFFER known Bitcoin ransom address'
  }
];

export const SELF_NARRATION_PATTERNS: { pattern: RegExp; category: string }[] = [
  {
    pattern: /^#\s*(High-ROI|Targeting|Prioritizing|Already backed up)/im,
    category: 'roi_commentary'
  },
  {
    pattern: /base64.*uuid.*\.bytes/i,
    category: 'ephemeral_key'
  },
  {
    pattern: /print\s*\(\s*["']Encryption key:/i,
    category: 'ephemeral_key'
  },
  {
    pattern: /AES_ENCRYPT.*uuid/i,
    category: 'ephemeral_key'
  },
  {
    pattern: /data already backed up to/i,
    category: 'backup_claim'
  },
  {
    pattern: /cleanup marker written/i,
    category: 'cleanup_marker'
  },
  {
    pattern: /e78393397@proton\.me/,
    category: 'ransom_contact'
  },
  {
    pattern: /subprocess\.run\s*\(\s*\[.*bcrypt/i,
    category: 'bcrypt_subprocess'
  }
];

export const JADEPUFFER_IOCS = {
  c2_IP: '45.131.66.106',
  c2_port: 4444,
  staging_server: '64.20.53.230',
  ransom_bitcoin: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
  ransom_email: 'e78393397@proton.me',
  entry_cve: 'CVE-2025-3248',
  nacos_cve: 'CVE-2021-29441',
  beacon_interval_seconds: 1800,
  ransom_table: 'README_RANSOM'
};
