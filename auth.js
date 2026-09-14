// ============================================================
// PRIVATE 섹션 — Supabase Auth Passkey(WebAuthn) 연동
// 비밀번호는 어디에도 만들지 않습니다.
// 최초 1회만 이메일 OTP로 계정을 확인하고, 이후에는 패스키로만 로그인합니다.
// ============================================================

let sb = null;
let currentUser = null;

function initSupabase() {
  if (!window.supabase || SUPABASE_URL.includes('YOUR_PROJECT') || SUPABASE_ANON_KEY.includes('YOUR_ANON_KEY')) {
    document.getElementById('private-msg').textContent =
      'Supabase 연결이 안 되어 있어요. index.html 맨 아래 SUPABASE_URL / SUPABASE_ANON_KEY를 채워 넣어주세요.';
    return false;
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { experimental: { passkey: true } },
  });
  return true;
}

function showMsg(text, isError) {
  const el = document.getElementById('private-msg');
  el.textContent = text || '';
  el.style.color = isError ? '#c4623a' : '#3f7a5d';
}

function updateGateUI() {
  const gate = document.getElementById('private-gate');
  const content = document.getElementById('private-content');
  const signedOutActions = document.getElementById('private-signedout-actions');
  const bootstrapBox = document.getElementById('bootstrap-box');

  if (currentUser) {
    gate.classList.add('hidden');
    content.classList.remove('hidden');
    document.getElementById('private-user-email').textContent = currentUser.email || '(이메일 없음)';
    loadPasskeys();
    loadPrivateNote();
  } else {
    gate.classList.remove('hidden');
    content.classList.add('hidden');
    signedOutActions.classList.remove('hidden');
    bootstrapBox.classList.add('hidden');
  }
}

// ---------- 이메일 OTP 부트스트랩 (최초 1회, 비밀번호 없음) ----------
async function sendOtp() {
  const email = document.getElementById('bootstrap-email').value.trim();
  if (!email) { showMsg('이메일을 입력하세요.', true); return; }
  showMsg('인증코드를 보내는 중...', false);
  const { error } = await sb.auth.signInWithOtp({ email });
  if (error) { showMsg('전송 실패: ' + error.message, true); return; }
  document.getElementById('otp-box').classList.remove('hidden');
  showMsg('이메일로 6자리 코드를 보냈어요. 코드를 확인해서 입력해주세요.', false);
}

async function verifyOtp() {
  const email = document.getElementById('bootstrap-email').value.trim();
  const token = document.getElementById('otp-code').value.trim();
  if (!token) { showMsg('코드를 입력하세요.', true); return; }
  showMsg('확인하는 중...', false);
  const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
  if (error) { showMsg('인증 실패: ' + error.message, true); return; }
  currentUser = data.user;
  showMsg('로그인됐어요. 이제 아래에서 패스키를 등록하면, 다음부터는 이메일 없이 패스키만으로 들어올 수 있어요.', false);
  updateGateUI();
}

// ---------- 패스키 등록/로그인 ----------
async function doRegisterPasskey() {
  showMsg('패스키 등록 중... (기기의 생체인증/보안키 요청이 뜰 거예요)', false);
  const { data, error } = await sb.auth.registerPasskey();
  if (error) { showMsg('패스키 등록 실패: ' + error.message, true); return; }
  showMsg('패스키가 등록됐어요: ' + (data.friendly_name || data.id), false);
  loadPasskeys();
}

async function doSignInWithPasskey() {
  showMsg('패스키로 로그인 중...', false);
  const { data, error } = await sb.auth.signInWithPasskey();
  if (error) { showMsg('로그인 실패: ' + error.message, true); return; }
  currentUser = data.user;
  showMsg('', false);
  updateGateUI();
}

async function doSignOut() {
  await sb.auth.signOut();
  currentUser = null;
  updateGateUI();
}

async function loadPasskeys() {
  const { data, error } = await sb.auth.passkey.list();
  const list = document.getElementById('passkey-list');
  if (error) { list.innerHTML = '<div class="private-msg">불러오기 실패: ' + error.message + '</div>'; return; }
  if (!data || !data.length) {
    list.innerHTML = '<div style="font-size:13px; color:#666;">등록된 패스키가 없어요.</div>';
    return;
  }
  list.innerHTML = data.map(pk => `
    <div class="passkey-row">
      <span>${escapeHtml(pk.friendly_name || '이름 없는 패스키')} <span style="color:#999;">· ${new Date(pk.created_at).toLocaleDateString('ko-KR')} 등록</span></span>
      <button type="button" onclick="deletePasskey('${pk.id}')">삭제</button>
    </div>
  `).join('');
}

async function deletePasskey(id) {
  if (!confirm('이 패스키를 지울까요? (다른 패스키가 하나 더 있어야 계속 로그인할 수 있어요)')) return;
  const { error } = await sb.auth.passkey.delete({ passkeyId: id });
  if (error) { showMsg('삭제 실패: ' + error.message, true); return; }
  loadPasskeys();
}

// ---------- 비공개 메모 (실제 개인정보 넣지 않기) ----------
async function loadPrivateNote() {
  const { data, error } = await sb.from('private_notes').select('*').eq('owner', currentUser.id).maybeSingle();
  const view = document.getElementById('note-view');
  if (error) { view.textContent = '불러오기 실패: ' + error.message; return; }
  view.textContent = data ? data.content : '(아직 메모가 없어요. "수정"을 눌러 만들어보세요.)';
  document.getElementById('note-textarea').value = data ? data.content : '';
}

function openNoteEdit() {
  document.getElementById('note-view-mode').classList.add('hidden');
  document.getElementById('note-edit-mode').classList.remove('hidden');
}
function cancelNoteEdit() {
  document.getElementById('note-view-mode').classList.remove('hidden');
  document.getElementById('note-edit-mode').classList.add('hidden');
}
async function saveNote() {
  const content = document.getElementById('note-textarea').value;
  const { data: existing } = await sb.from('private_notes').select('id').eq('owner', currentUser.id).maybeSingle();
  let error;
  if (existing) {
    ({ error } = await sb.from('private_notes').update({ content, updated_at: new Date().toISOString() }).eq('id', existing.id));
  } else {
    ({ error } = await sb.from('private_notes').insert({ owner: currentUser.id, content }));
  }
  if (error) { showMsg('저장 실패: ' + error.message, true); return; }
  cancelNoteEdit();
  loadPrivateNote();
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 이벤트 연결 + 시작 ----------
(function boot() {
  const ok = initSupabase();
  document.getElementById('btn-show-bootstrap').onclick = () => {
    document.getElementById('bootstrap-box').classList.remove('hidden');
  };
  document.getElementById('btn-send-otp').onclick = sendOtp;
  document.getElementById('btn-verify-otp').onclick = verifyOtp;
  document.getElementById('btn-passkey-signin').onclick = doSignInWithPasskey;
  document.getElementById('btn-register-passkey').onclick = doRegisterPasskey;
  document.getElementById('btn-signout').onclick = doSignOut;
  document.getElementById('btn-edit-note').onclick = openNoteEdit;
  document.getElementById('btn-cancel-note').onclick = cancelNoteEdit;
  document.getElementById('btn-save-note').onclick = saveNote;

  if (!ok) return;

  sb.auth.onAuthStateChange((event, session) => {
    currentUser = session ? session.user : null;
    updateGateUI();
  });

  sb.auth.getSession().then(({ data: { session } }) => {
    currentUser = session ? session.user : null;
    updateGateUI();
  });
})();
