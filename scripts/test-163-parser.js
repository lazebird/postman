// 测试 163 API 响应解析（使用正则方法）
const testResponse = `{\n'code':'S_OK',\n'var':[{\n'id':'249:1tbiZAlVy0Jw0qbz6gABst',\n'fid':3,\n'flags':{\n'read':true},\n},{\n'id':'753:xtbC8Qo6BmqaG8oq4AAA3s',\n'fid':1,\n'flags':{\n},\n}]\n}`;

console.log('Original:', testResponse);

let jsonText = testResponse.trim();

// 将 new Date(...) 替换为 null（虽然这个测试中没有）
jsonText = jsonText.replace(/\bnew\s+Date\([^)]*\)/g, 'null');

// 使用正则提取每封邮件，统计未读数
const emailRegex = /\{\s*'id'\s*:/g;
let unreadCount = 0;
let emailMatch;

while ((emailMatch = emailRegex.exec(jsonText)) !== null) {
  // 找到这封邮件的结束位置
  const nextEmail = jsonText.substring(emailMatch.index + 1).match(/\{\s*'id'\s*:/);
  const emailEnd = nextEmail ? emailMatch.index + 1 + nextEmail.index : jsonText.indexOf(']', emailMatch.index);
  const emailText = jsonText.substring(emailMatch.index, emailEnd);

  // 检查这封邮件是否有 read:true（已读）
  const hasRead = /'read'\s*:\s*true/.test(emailText);

  if (!hasRead) {
    unreadCount++;
  }
}

console.log('Unread count:', unreadCount);

