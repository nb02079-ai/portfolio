-- ============================================================
-- 포트폴리오 PRIVATE 섹션용 스키마
-- Supabase 프로젝트의 SQL Editor에 그대로 붙여넣어 실행하세요.
--
-- 패스키(공개키) 자체는 Supabase Auth가 내부적으로 관리하는 테이블에
-- 저장되므로, 우리가 따로 만들 필요가 없습니다. 우리가 만들 건
-- "로그인한 사람만 보는 비공개 메모" 표 하나뿐입니다.
-- ============================================================

create table if not exists private_notes (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table private_notes enable row level security;

drop policy if exists "own private note" on private_notes;
create policy "own private note" on private_notes for all
  using (auth.uid() = owner) with check (auth.uid() = owner);
