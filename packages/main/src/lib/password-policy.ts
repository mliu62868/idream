// SPEC: 新密码规则（注册、恢复码重置、邮件重置、登录后改密码共用），前后端同一份。
// INTENT: 按 NIST SP 800-63B：只设长度下限 + 拒绝常见/已泄露密码 + 不得等于账号邮箱；
//   不加「必须含大写/数字/符号」之类组合规则——它们逼出 Password1! 这种更好猜的密码。
//   黑名单是常见泄露榜单里 ≥8 位的头部短表，不是完整泄露库：挡住最先被撞库的那批，
//   不引入外部服务或大字典。
// INVARIANT: 比较一律小写，Password1 与 password1 同样被拒。
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 1024;

export const PASSWORD_HINT =
  "At least 8 characters. Common passwords and your email address are not allowed.";

const commonPasswords = new Set([
  "password", "password1", "password12", "password123", "password1234", "passw0rd",
  "p@ssw0rd", "p@ssword", "12345678", "123456789", "1234567890", "0123456789",
  "87654321", "987654321", "12341234", "12121212", "123123123", "11223344",
  "11111111", "00000000", "22222222", "66666666", "88888888", "99999999",
  "qwertyui", "qwertyuiop", "qwerty123", "qwerty12", "1q2w3e4r", "1q2w3e4r5t",
  "1qaz2wsx", "zaq12wsx", "q1w2e3r4", "qwer1234", "1234qwer", "asdfghjk",
  "asdf1234", "zxcvbnm1", "qweasdzxc", "123qweasd", "abcd1234", "abc12345",
  "a1b2c3d4", "aa123456", "iloveyou", "iloveyou1", "sunshine", "princess",
  "football", "baseball", "superman", "starwars", "whatever", "trustno1",
  "letmein1", "welcome1", "welcome123", "computer", "internet", "michelle",
  "jennifer", "jordan23", "mustang1", "charlie1", "shadow12", "monkey123",
  "dragon12", "freedom1", "master12", "changeme", "admin123", "administrator",
  "login123", "chocolate", "butterfly", "liverpool", "pokemon1", "blink182",
  "samsung1", "secret12", "loveyou1", "babygirl", "sexysexy", "iloveyou2",
  "idream123", "idreamai", "ourdream", "ourdream1",
]);

/** 返回面向用户的问题描述；合格返回 null。 */
export function newPasswordProblem(password: string, email?: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return "Password must be at least 8 characters.";
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return "Password must be 1024 characters or fewer.";
  }
  const normalized = password.toLowerCase();
  if (commonPasswords.has(normalized) || /^(.)\1+$/.test(normalized)) {
    return "This password is too common. Choose something less predictable.";
  }
  const normalizedEmail = email?.trim().toLowerCase();
  if (
    normalizedEmail &&
    (normalized === normalizedEmail || normalized === normalizedEmail.split("@")[0])
  ) {
    return "Password cannot be your email address.";
  }
  return null;
}
