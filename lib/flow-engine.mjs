import fs from 'node:fs';
import {copyFile, mkdir, readdir, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {findSystemChrome} from './runtime.mjs';

export const FLOW_URL = 'https://flow.google.com/';

export const FLOW_MODELS = {
  'omni-1.2-720p': {
    id: 'omni-1.2-720p',
    label: 'Omni Flash 1.2 · 720p 고화질 (기본 추천)',
    modelKeyword: 'Omni',
    resolution: '720p',
    defaultSeconds: 15,
    maxSeconds: 15,
    creditsPerSec: 3,
    description: '공식몰 누끼·마네킨 샷·동영상 멀티 레퍼런스로 옷 원본 일관성이 가장 뛰어납니다.',
  },
  'omni-1.2-360p': {
    id: 'omni-1.2-360p',
    label: 'Omni Flash 1.2 · 360p 초안 검수 (절약형)',
    modelKeyword: 'Omni',
    resolution: '360p',
    defaultSeconds: 15,
    maxSeconds: 15,
    creditsPerSec: 1,
    description: '초당 1크레딧으로 옷 변형 여부를 먼저 확인하고 마음에 들 때 고화질로 올릴 수 있습니다.',
  },
  'veo-3.1-lite': {
    id: 'veo-3.1-lite',
    label: 'Veo 3.1 Lite · 가성비 대량 제작 (8초)',
    modelKeyword: 'Veo 3.1',
    resolution: '720p',
    defaultSeconds: 8,
    maxSeconds: 8,
    flatCredits: 5,
    description: '편당 약 5크레딧(구독 기준)으로 여러 품번을 빠르게 대량 제작할 때 적합합니다.',
  },
};

export const FLOW_PRESETS = {
  // =====================================================================
  // 👕 상의 · 아우터 전용 15종 (전문 패션 영상감독 3막 타임라인 구성)
  // =====================================================================
  'top-360-spin': {
    id: 'top-360-spin',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '상의 360도 한 바퀴 회전 핏',
    prompt: '[1막 0~4초 · 오프닝 옷 집중] 시작 프레임 정면 자세에서 상의·아우터의 넥라인, 어깨 드롭, 가슴 핏에 시선을 고정하며 여유롭게 출발합니다. [2막 4~10초 · 360도 한 바퀴 입체 회전] 모델이 중심축을 유지한 채 천천히 우아하게 한 바퀴(정면→측면→뒷판 등 라인과 뒷기장→다시 정면) 돌며 소매 통, 옆 실루엣, 뒷면 마감까지 앞·옆·뒤 360도 전체 핏을 숨김없이 보여줍니다. [3막 10~15초 · 정면 마감 푸시인] 정면으로 돌아온 뒤 상반신 쪽으로 부드럽게 슬로우 푸시인하며 원단 결과 봉제선을 또렷하게 각인시킵니다. [감독 카메라·조명] 50mm 무왜곡 화각 고정 아이레벨 + 회전할 때마다 원단 표면에 은은한 입체광이 흐르는 CRI 97 소프트 스튜디오 자연광.',
  },
  'top-stretch-span': {
    id: 'top-stretch-span',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '팔 뻗기·스트레치 스판 신축성',
    prompt: '[1막 0~4초 · 편안한 착장 오프닝] 정면에서 단정한 상의·아우터 실루엣을 또렷하게 보여줍니다. [2막 4~10초 · 스판 신축성·활동성 실증] 모델이 양팔을 자연스럽게 앞으로 뻗거나 어깨와 팔꿈치를 부드럽게 접었다 펴고 상체를 좌우로 가볍게 틀며, 겨드랑이와 등판에 당김 없이 유연하게 늘어나고 곧바로 매끄럽게 복원되는 뛰어난 신축성과 편안한 착용감을 직관적으로 증명합니다. [3막 10~15초 · 복원 핏 마무리] 동작 후에도 구김이나 흐트러짐 없이 깔끔하게 돌아오는 어깨선과 몸통 핏을 상반신 미디엄 샷으로 마무리합니다. [감독 카메라·조명] 55mm 안정적인 짐벌 트래킹 + 원단의 탄성 주름과 복원력이 선명히 보이는 밝은 확산 주광.',
  },
  'top-signature-lookbook': {
    id: 'top-signature-lookbook',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '상의 시그니처 스튜디오 룩북',
    prompt: '[1막 0~4초 · 오프닝 실루엣] 정면 풀샷에서 상의의 전체 비율과 깔끔한 컬러감으로 시선을 사로잡습니다. [2막 4~10초 · 자연스러운 핏 연출] 모델이 체중을 한쪽으로 부드럽게 옮기며 40도 반회전해 어깨 재봉선, 소매 볼륨, 허리 밑단 떨어짐을 입체적으로 보여줍니다. [3막 10~15초 · 상반신 시네마 푸시인] 허리 위 상반신으로 유려하게 슬로우 푸시인하며 옷의 완성도와 원단 결을 고급 화보처럼 담아냅니다. [감독 카메라·조명] 85mm 단렌즈 얕은 심도 배경 정리 + 색 왜곡 없는 하이엔드 소프트박스 라이팅.',
  },
  'top-outer-volume': {
    id: 'top-outer-volume',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '아우터 입체 볼륨·레이어드 턴',
    prompt: '[1막 0~4초 · 아우터 실루엣 오프닝] 패딩·자켓·코트의 가벼우면서도 풍성한 입체 실루엣을 전신~쓰리쿼터 프레임에 가득 담습니다. [2막 4~10초 · 레이어드·볼륨 입체 회전] 모델이 상체를 부드럽게 반회전하고 앞여밈 자락을 자연스럽게 여미거나 팔을 살짝 들어 올려, 퀼팅 볼륨감·이너와의 세련된 레이어드 핏·가벼운 착용감을 생생하게 보여줍니다. [3막 10~15초 · 퀼팅·충전재 질감 강조] 가슴과 어깨 볼륨 라인으로 천천히 다가가며 고급스러운 광택과 마감 디테일로 마무리합니다. [감독 카메라·조명] 완만한 아크 짐벌 무빙 + 퀼팅 굴곡마다 부드러운 하이라이트를 만드는 측면 보조광.',
  },
  'top-fabric-macro': {
    id: 'top-fabric-macro',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '상의 원단 짜임·기모 클로즈업',
    prompt: '[1막 0~4초 · 상체 전체 핏 제시] 상의의 정갈한 전체 핏과 실제 색감을 또렷하게 보여줍니다. [2막 4~10초 · 원단 결 정밀 슬로우 푸시인] 모델은 미세한 호흡만 유지하고, 카메라가 넥라인·어깨 봉제선·가슴 원단 조직 영역으로 매끄럽고 정교하게 다가갑니다. [3막 10~15초 · 텍스처·부자재 극대화] 니트 짜임, 기모 두께감, 코튼 조직, 지퍼·단추·스티치 마감의 고급스러움을 눈앞에서 만지는 듯 선명하게 담아냅니다. [감독 카메라·조명] 85mm 준망원 초정밀 포커스 + 측면에서 부드럽게 스치는 그레이징 라이트로 원단 결 입체화.',
  },
  'top-collar-zipper': {
    id: 'top-collar-zipper',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '카라·앞여밈·소매 디테일 정돈',
    prompt: '[1막 0~4초 · 상체 정면 컷] 단정한 정면 스탠딩으로 카라와 앞여밈 중심 라인을 깔끔하게 보여줍니다. [2막 4~10초 · 손끝 디테일 강조 동작] 모델이 한 손으로 카라 각도나 지퍼·단추 앞여밈, 소매 커프스 끝단을 가볍고 우아하게 정돈하는 자연스러운 제스처로 재단 완성도와 마감 퀄리티를 돋보이게 합니다. [3막 10~15초 · 여유로운 정면 마무리] 정면을 응시하며 반듯하게 잡힌 어깨선과 상의 실루엣으로 마무리합니다. [감독 카메라·조명] 70mm 포트레이트 렌즈 슬로우 패닝 + 어깨·소매 외곽을 분리하는 은은한 림라이트.',
  },
  'top-drape-knit': {
    id: 'top-drape-knit',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '니트·티셔츠 포근한 드레이프',
    prompt: '[1막 0~4초 · 부드러운 첫인상] 허리 위 미디엄 샷에서 니트·티셔츠 특유의 포근한 색감과 여유로운 핏을 보여줍니다. [2막 4~10초 · 원단 유연성·드레이프 표현] 모델이 어깨 힘을 빼고 상체를 부드럽게 좌우로 기울이거나 천천히 호흡하며, 피부에 닿는 부드러운 촉감과 몸을 감싸며 흐르는 유연한 원단 주름을 생생하게 표현합니다. [3막 10~15초 · 질감 여운 엔딩] 은은하게 다가가는 푸시인으로 포근한 짜임과 넥라인 탄탄함을 강조하며 마무리합니다. [감독 카메라·조명] 부드럽게 호흡하는 핸드헬드급 시네마 무빙 + 따뜻한 확산 자연광.',
  },
  'top-hoodie-casual': {
    id: 'top-hoodie-casual',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '후드·맨투맨 시보리 캐주얼 워킹',
    prompt: '[1막 0~4초 · 영 캐주얼 오프닝] 여유로운 드롭 숄더와 탄탄한 밑단·소매 시보리가 돋보이는 정면 스탠스로 시작합니다. [2막 4~10초 · 경쾌한 워킹·주머니 포즈] 모델이 앞으로 두세 걸음 가볍게 걸어오며 앞 포켓에 손을 툭 넣거나 몸을 살짝 흔들어, 탄탄한 스웻·기모 원단의 형태 유지력과 입체적인 후드·어깨 볼륨을 생동감 있게 보여줍니다. [3막 10~15초 · 상반신 핏 고정] 힘 뺀 꾸안꾸 포즈로 멈추며 데일리 활용도를 각인시킵니다. [감독 카메라·조명] 경쾌한 짐벌 돌리아웃 트래킹 + 밝고 깨끗한 데이라이트 조명.',
  },
  'top-shirt-clean': {
    id: 'top-shirt-clean',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '셔츠·블라우스 단정한 에디토리얼',
    prompt: '[1막 0~4초 · 수직 실루엣 오프닝] 구김 없이 반듯하게 떨어지는 셔츠·블라우스의 정면 실루엣을 정갈하게 제시합니다. [2막 4~10초 · 45도 반회전·커프스 라인] 모델이 천천히 45도 몸을 돌려 카라 각도, 앞 플라켓 단추 배열, 등판 여유분과 소매 커프스 핏을 지적으로 보여줍니다. [3막 10~15초 · 클린 상반신 푸시인] 산뜻한 원단 표면 결과 깔끔한 넥라인으로 마무리합니다. [감독 카메라·조명] 수직·수평 완벽 정렬 매거진 프레임 + 맑은 화이트 데이라이트.',
  },
  'top-orbit-3d': {
    id: 'top-orbit-3d',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '상의 좌우 입체 오빗(두께감 강조)',
    prompt: '[1막 0~4초 · 중심 고정 오프닝] 모델이 흔들림 없는 당당한 포즈로 상의 정면 실루엣을 잡아줍니다. [2막 4~10초 · 좌→우 30도 패럴랙스 오빗] 카메라가 모델 상체를 축으로 좌에서 우로 완만한 반원을 그리며 이동해, 평면 사진에서는 느낄 수 없는 옷의 입체적인 두께감, 어깨 볼륨, 소매 실루엣을 입체적으로 펼쳐 보입니다. [3막 10~15초 · 중앙 안착] 정면으로 안착하며 원단 색감과 전체 밸런스를 정리합니다. [감독 카메라·조명] 초정밀 슬라이더 오빗 무빙 + 배경 깊이감을 살린 입체 3점 조명.',
  },
  'top-street-daily': {
    id: 'top-street-daily',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '도심 자연광 상의 데일리 워킹',
    prompt: '[1막 0~4초 · 야외 데일리 오프닝] 정돈된 미니멀 도심 거리에서 실제 일상 속 상의·아우터 착용감을 자연스럽게 보여줍니다. [2막 4~10초 · 자연스러운 걸음과 미풍] 모델이 여유롭게 걸어오다 살짝 멈춰 돌아보며, 햇살과 미풍 속에서 옷자락이 자연스럽게 움직이는 실착 핏을 보여줍니다. [3막 10~15초 · 상체 포커스 마무리] 배경은 부드럽게 날리고 상의의 실제 색감과 핏에 온전히 시선을 모읍니다. [감독 카메라·조명] 얕은 심도 짐벌 트래킹 + 색감 왜곡 없는 맑은 주광.',
  },
  'top-winter-mood': {
    id: 'top-winter-mood',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '겨울 공기감 포근한 보온 상의 무드',
    prompt: '[1막 0~4초 · 차분한 시즌 오프닝] 깨끗하고 차분한 겨울 공기감 속에서 기모·니트·패딩 상의의 포근한 첫인상을 전달합니다. [2막 4~10초 · 포근한 보온 제스처] 모델이 옷깃이나 소매를 가볍게 여미며 여유롭게 숨을 고르고 반회전해, 두툼하고 따뜻한 보온감과 안정적인 실루엣을 설득력 있게 표현합니다. [3막 10~15초 · 원단 온기 클로즈업] 부드러운 하이라이트가 맺힌 원단 표면 질감으로 마무리합니다. [감독 카메라·조명] 느린 호흡의 시네마틱 푸시인 + 투명한 겨울 자연광.',
  },
  'top-gallery-high': {
    id: 'top-gallery-high',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '하이엔드 갤러리 상의 캠페인',
    prompt: '[1막 0~4초 · 글로벌 캠페인 오프닝] 군더더기 없는 미니멀 건축 공간에서 절제된 정면 포즈로 상의의 조형적 실루엣을 주인공으로 세웁니다. [2막 4~10초 · 미니멀 슬로우 무빙] 불필요한 제스처를 덜어내고 느린 체중 이동과 시선 전환만으로 옷의 재단선과 핏의 완성도에 압도적으로 집중시킵니다. [3막 10~15초 · 묵직한 푸시인 엔딩] 상반신 핵심 라인을 고급 매거진 필름처럼 마무리합니다. [감독 카메라·조명] 묵직한 시네마 돌리 인 + 천창 확산 자연광.',
  },
  'top-office-clean': {
    id: 'top-office-clean',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '출근길 깔끔 오피스 상의 룩',
    prompt: '[1막 0~4초 · 단정한 출근룩 오프닝] 깔끔한 모던 오피스 라운지 분위기에서 단정하고 신뢰감 있는 상의·자켓 핏으로 시작합니다. [2막 4~10초 · 세련된 걸음·반측면 핏] 모델이 반듯한 자세로 두 걸음 걸어온 뒤 살짝 몸을 틀어, 출근룩·세미 포멀 코디에서의 깔끔한 어깨선과 기장 비율을 보여줍니다. [3막 10~15초 · 단정한 마무리] 정면 상반신 미디엄 샷으로 정갈하게 끝맺습니다. [감독 카메라·조명] 수평 안정 짐벌 트래킹 + 고연색성 주광색 조명.',
  },
  'top-sunlight-texture': {
    id: 'top-sunlight-texture',
    garmentGroup: 'top',
    category: '👕 상의·아우터',
    label: '오후 햇살 상의 원단 결 필름',
    prompt: '[1막 0~4초 · 감성 채광 오프닝] 창가로 들어오는 부드러운 오후 햇살 아래 상의의 실제 색감이 맑게 살아나는 구도로 시작합니다. [2막 4~10초 · 빛을 따라 흐르는 핏] 모델이 천천히 몸을 틀 때마다 햇빛이 어깨와 가슴 원단 결을 부드럽게 스치며 소재의 고급스러움과 자연스러운 주름을 감성적으로 드러냅니다. [3막 10~15초 · 여운 있는 줌인] 과장된 색보정 없이 깨끗한 자연 윤곽광으로 마무리합니다. [감독 카메라·조명] 서정적인 슬로우 푸시인 + 색 변질 없는 순수 자연 채광.',
  },

  // =====================================================================
  // 👖 하의 전용 15종 (전문 패션 영상감독 3막 타임라인 구성 · 바지 100% 주인공)
  // =====================================================================
  'bottom-360-spin': {
    id: 'bottom-360-spin',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '하의 360도 한 바퀴 회전 전신 핏',
    prompt: '[1막 0~4초 · 전신 정면 하의 오프닝] 허리선부터 발끝 신발 라인까지 하의 전체가 프레임 안에 온전히 보이는 정면 풀샷으로 바지의 일자·와이드 핏에 시선을 고정합니다. [2막 4~10초 · 360도 한 바퀴 입체 회전] 모델이 중심을 잡고 천천히 한 바퀴(정면→옆 봉제선과 허벅지 통→뒷면 힙 라인과 백포켓·기장 떨어짐→다시 정면) 돌며 바지의 앞·옆·뒤 360도 전체 실루엣을 완벽하게 증명합니다. [3막 10~15초 · 정면 하체 핏 마무리] 정면으로 돌아와 안정적으로 서며 허리부터 밑단까지 깔끔하게 떨어지는 핏으로 마무리합니다. [감독 카메라·조명] 바지가 절대 잘리지 않는 50mm 전신 아이레벨 고정 + 다리 라인과 주름이 입체적으로 보이는 고연색성 스튜디오 광.',
  },
  'bottom-sit-stand-span': {
    id: 'bottom-sit-stand-span',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '앉았다 일어나도 편한 스판 신축성',
    prompt: '[1막 0~4초 · 정면 스탠딩 핏 확인] 허리 밴딩부터 밑단까지 깔끔하게 떨어지는 하의의 정면 전신 실루엣을 또렷하게 보여줍니다. [2막 4~10초 · 앉았다 일어서기 신축성 실증] 모델이 스튜디오 스툴(또는 낮은 벤치)에 자연스럽게 앉았다가 다리를 편안하게 움직인 뒤 부드럽게 일어서며(또는 무릎을 자연스럽게 굽혔다 펴며), 허리·힙·허벅지·무릎 어디에도 당김이나 뻣뻣함 없이 유연하게 늘어나는 뛰어난 스판 신축성과 편안한 착용감을 눈으로 직접 증명합니다. [3막 10~15초 · 무릎 나옴 없는 즉각 복원 핏] 일어선 직후 무릎이나 허벅지 주름이 곧바로 매끄럽게 펴지며 일자 핏으로 복원되는 탄성을 강조해 마무리합니다. [감독 카메라·조명] 전신~하체 중심 50mm 안정 트래킹 + 원단 신축과 복원 흐름이 또렷한 밝은 자연광.',
  },
  'bottom-big-stride-span': {
    id: 'bottom-big-stride-span',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '큰 보폭·스텝 활동성 스판 컷',
    prompt: '[1막 0~4초 · 하의 중심 오프닝] 허리선과 다리 전체 라인이 반듯하게 보이는 정면 전신 자세로 시작합니다. [2막 4~10초 · 큰 보폭 워킹·방향 전환 활동성] 모델이 평소보다 여유롭고 힘 있는 큰 보폭으로 앞을 향해 성큼성큼 걸어온 뒤 가볍게 방향을 틀어, 허벅지와 무릎 움직임을 전혀 방해하지 않는 사방 스판 신축성과 활동적인 착용감을 생동감 있게 보여줍니다. [3막 10~15초 · 탄탄한 실루엣 정지] 걸음을 멈추는 순간 바지 통이 툭 떨어지며 정리되는 깔끔한 핏으로 마무리합니다. [감독 카메라·조명] 모델 보폭에 정확히 호흡을 맞춘 로우아이레벨 짐벌 돌리아웃 트래킹 + 선명한 데이라이트.',
  },
  'bottom-fit-silhouette': {
    id: 'bottom-fit-silhouette',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '팬츠 일자·와이드 핏 시그니처 룩북',
    prompt: '[1막 0~4초 · 완벽한 바지 실루엣 오프닝] 허리선부터 허벅지, 무릎, 밑단, 신발 얹힘까지 바지 전체 핏이 한눈에 들어오는 정면 풀샷으로 시선을 사로잡습니다. [2막 4~10초 · 두 걸음 워킹 & 스탠스] 모델이 앞으로 부드럽게 두 걸음 내디딘 뒤 균형 잡힌 스탠스로 서서, 걸음마다 자연스럽게 흐르는 바지 통 넓이와 군더더기 없는 떨어짐을 보여줍니다. [3막 10~15초 · 하체 중심 슬로우 푸시인] 허리부터 밑단까지 바지가 주인공인 구도를 유지하며 원단 퀄리티로 마무리합니다. [감독 카메라·조명] 다리 비율이 길고 곧게 보이는 로우아이레벨 구도 + 앞판 중심선·옆 봉제선이 또렷한 자연광.',
  },
  'bottom-tilt-waist-hem': {
    id: 'bottom-tilt-waist-hem',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '허리선→밑단 시네마 틸트 스캔',
    prompt: '[1막 0~4초 · 허리 디테일 시작] 허리 밴딩·스트링·지퍼 여밈과 포켓 마감에 또렷하게 초점을 맞추며 출발합니다. [2막 4~10초 · 허리→허벅지→무릎→밑단 슬로우 틸트] 카메라가 일정한 시네마 속도로 허벅지 통, 무릎 라인, 바지 기장, 신발 위에 자연스럽게 떨어지는 밑단까지 매끄럽게 훑어 내려간 뒤 다시 전신으로 펼쳐 보입니다. [3막 10~15초 · 전체 비율 완성] 모델이 미세하게 체중을 옮기며 완성된 하의 전신 비율을 보여주고 마무리합니다. [감독 카메라·조명] 기계처럼 정교한 수직 짐벌 틸트 + 상하단 밝기 편차 없는 균일 에디토리얼 라이팅.',
  },
  'bottom-lowangle-ratio': {
    id: 'bottom-lowangle-ratio',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '다리 길어 보이는 로우앵글 워킹',
    prompt: '[1막 0~4초 · 압도적 프로포션 오프닝] 허리보다 살짝 낮은 세련된 로우앵글에서 길고 시원하게 뻗은 바지 실루엣으로 첫 시선을 끕니다. [2막 4~10초 · 당당한 런웨이 워킹] 모델이 정면을 향해 자신감 있고 안정적인 보폭으로 천천히 세 걸음 걸어오며, 바지 기장과 다리 비율이 가장 이상적으로 길어 보이는 착용 효과를 극대화합니다. [3막 10~15초 · 엣지 있는 정지 포즈] 한 발을 살짝 앞에 둔 룩북 스탠스로 멈추며 다리 라인을 각인시킵니다. [감독 카메라·조명] 과도한 광각 왜곡 없는 45mm 로우앵글 짐벌 트래킹 + 입체 그림자 조명.',
  },
  'bottom-side-turn-hip': {
    id: 'bottom-side-turn-hip',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '45도 옆선·힙·허벅지 여유 핏',
    prompt: '[1막 0~4초 · 정면 핏 제시] 정면 전신에서 바지의 깔끔한 앞판 라인과 통 넓이를 보여줍니다. [2막 4~10초 · 45도 반회전 옆 실루엣 강조] 모델이 아주 천천히 45도 측면으로 몸을 돌려, 구매 고객이 가장 궁금해하는 옆 봉제선 떨어짐, 힙과 허벅지의 여유 공간, 무릎 뒤 주름이 과하지 않은 깔끔한 옆 실루엣을 입체적으로 보여줍니다. [3막 10~15초 · 정면 복귀] 여유롭게 정면으로 돌아오며 전체 하의 핏을 정리합니다. [감독 카메라·조명] 50mm 아이레벨 고정 + 옆선 입체감을 살리는 소프트 키라이트.',
  },
  'bottom-drape-walk': {
    id: 'bottom-drape-walk',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '걸음마다 살아나는 바지 통 드레이프',
    prompt: '[1막 0~4초 · 정지 실루엣] 바닥을 향해 툭 떨어지는 바지 통의 우아한 낙하감을 정면에서 보여줍니다. [2막 4~10초 · 리듬감 있는 워킹 드레이프] 모델이 여유로운 리듬으로 서너 걸음 걸으며, 매 걸음마다 바지 원단이 공기감을 머금고 부드럽게 흔들렸다가 곧바로 일자로 복원되는 고급 TR·기모·면 원단의 탄성과 드레이프를 생생하게 담아냅니다. [3막 10~15초 · 밑단 여운] 발목과 밑단 주름의 매끄러운 움직임을 끝까지 살리며 마무리합니다. [감독 카메라·조명] 짐벌 팔로우 트래킹 + 원단 흔들림의 미세한 명암을 살리는 자연광.',
  },
  'bottom-waist-pocket': {
    id: 'bottom-waist-pocket',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '허리 밴딩·스트링·주머니 디테일',
    prompt: '[1막 0~4초 · 전신→허리선 포커스] 전신 구도에서 출발해 바지 허리선과 포켓 디테일로 시선을 자연스럽게 모읍니다. [2막 4~10초 · 주머니 손 & 허리선 자연스러운 제스처] 모델이 양손 또는 한 손을 바지 주머니에 자연스럽게 넣었다 빼며 허리 히든 밴딩·스트링·포켓 입구 마감의 실용성과 편안한 허리 핏을 강조합니다. [3막 10~15초 · 꾸안꾸 전신 밸런스] 주머니에 손을 가볍게 걸친 여유로운 전신 스탠스로 마무리합니다. [감독 카메라·조명] 바지가 절대 잘리지 않는 미디엄 풀샷 + 부드러운 창가 자연광.',
  },
  'bottom-fabric-zoom': {
    id: 'bottom-fabric-zoom',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '바지 원단 결·기모 두께감 줌인',
    prompt: '[1막 0~4초 · 전체 하의 컬러·핏 제시] 바지의 실제 색감과 전체 핏을 선명하게 보여줍니다. [2막 4~10초 · 허벅지·무릎 원단 정밀 푸시인] 모델이 미세하게 체중을 옮기는 동안 카메라가 허리~허벅지·옆 봉제선 영역으로 부드럽게 다가갑니다. [3막 10~15초 · 소재 퀄리티 증명] 기모 스웻의 포근한 두께감, TR 슬랙스의 매끈한 결, 데님·치노의 탄탄한 직조감과 꼼꼼한 스티치 마감을 사실적으로 부각합니다. [감독 카메라·조명] 70mm 준망원 슬로우 푸시인 + 측면 그레이징 라이트.',
  },
  'bottom-hem-shoes': {
    id: 'bottom-hem-shoes',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '밑단 기장·슈즈 떨어짐 집중 컷',
    prompt: '[1막 0~4초 · 하체 풀샷 오프닝] 허리선부터 발끝 신발까지 기장 비율이 한눈에 보이는 프레임으로 시작합니다. [2막 4~10초 · 발걸음 & 밑단 얹힘 강조] 모델이 가볍게 발을 교차하거나 한 걸음 내디뎌, 바지 밑단이 운동화·구두 위에 구겨짐 없이 멋스럽게 툭 얹히는 기장감과 밑단 통 넓이를 또렷하게 보여줍니다. [3막 10~15초 · 전신 비율 마무리] 아래에서 위로 살짝 시선을 열어주며 하의 전체 코디 밸런스를 완성합니다. [감독 카메라·조명] 낮은 아이레벨 안정 샷 + 바닥과 밑단 경계가 선명한 화이트 스튜디오 광.',
  },
  'bottom-orbit-3d': {
    id: 'bottom-orbit-3d',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '하의 좌우 입체 오빗(통 넓이 강조)',
    prompt: '[1막 0~4초 · 중심 고정 전신 컷] 모델이 균형 잡힌 포즈로 서서 바지 정면 라인을 안정적으로 유지합니다. [2막 4~10초 · 좌→우 25도 패럴랙스 하체 오빗] 카메라가 모델 정면을 축으로 좌에서 우로 부드러운 반원을 그리며 이동해, 바지 통의 입체적인 여유감과 앞·옆 라인의 조형적인 떨어짐을 생생하게 전달합니다. [3막 10~15초 · 정면 안착] 정면으로 부드럽게 멈추며 바지 전체 실루엣을 각인시킵니다. [감독 카메라·조명] 무진동 슬라이더 오빗 + 배경과 하의 윤곽을 깔끔히 분리하는 3점 조명.',
  },
  'bottom-office-slacks': {
    id: 'bottom-office-slacks',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '출근길 깔끔 슬랙스·치노 워킹',
    prompt: '[1막 0~4초 · 단정한 오피스 하의 오프닝] 깔끔한 모던 빌딩·라운지 분위기에서 군더더기 없는 테이퍼드·일자 슬랙스 핏으로 시작합니다. [2막 4~10초 · 지적인 워킹과 반회전] 모델이 반듯한 자세로 두세 걸음 걸어온 뒤 주머니에 한 손을 넣고 살짝 돌아서서, 출근룩·비즈니스 캐주얼에서의 깔끔한 주름 복원력과 단정한 다리 라인을 강조합니다. [3막 10~15초 · 신뢰감 있는 전신 마무리] 발끝까지 또렷한 전신 핏으로 마무리합니다. [감독 카메라·조명] 반듯한 짐벌 트래킹 + 색감 왜곡 없는 깨끗한 주광.',
  },
  'bottom-street-daily': {
    id: 'bottom-street-daily',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '도심 스트릿 데일리 팬츠 워킹',
    prompt: '[1막 0~4초 · 일상 실착 오프닝] 정돈된 미니멀 도심 보도 위에서 실제로 외출했을 때의 현실적이고 세련된 팬츠 핏을 보여줍니다. [2막 4~10초 · 자연스러운 거리 워킹] 모델이 편안한 보폭으로 걷다가 잠시 멈춰 서서, 야외 자연광 속 실제 바지 색감과 걸을 때의 자연스러운 원단 찰랑임을 생생하게 담아냅니다. [3막 10~15초 · 전신 룩북 엔딩] 배경 거리는 은은하게 아웃포커싱하고 바지 실루엣에 온전히 시선을 집중시킵니다. [감독 카메라·조명] 얕은 심도 짐벌 팔로우 + 맑은 야외 확산 주광.',
  },
  'bottom-gallery-longtake': {
    id: 'bottom-gallery-longtake',
    garmentGroup: 'bottom',
    category: '👖 하의',
    label: '미니멀 갤러리 하의 롱테이크',
    prompt: '[1막 0~4초 · 하이엔드 미니멀 오프닝] 군더더기 없는 건축적 스튜디오 공간에 삼각대처럼 완벽히 고정된 전신 9:16 프레임으로 바지 실루엣 자체를 예술 작품처럼 세웁니다. [2막 4~10초 · 절제된 포즈 체인지] 카메라 흔들림 없이 모델이 천천히 체중을 옮기고 30도 각도를 바꾸며, 오직 바지의 완벽한 패턴과 떨어지는 선만으로 고급감을 전달합니다. [3막 10~15초 · 여운 있는 정지] 차분한 정면 스탠스로 깊은 여운을 남기며 마무리합니다. [감독 카메라·조명] 완전 고정 9:16 시네마 롱테이크 + 천창 자연 채광.',
  },
};

export function estimateFlowCredits(modelId = 'omni-1.2-720p', durationSec = 10) {
  const model = FLOW_MODELS[modelId] || FLOW_MODELS['omni-1.2-720p'];
  if (Number.isFinite(model.flatCredits)) return model.flatCredits;
  const clamped = Math.max(4, Math.min(model.maxSeconds, Math.round(Number(durationSec) || model.defaultSeconds)));
  return clamped * model.creditsPerSec;
}

/**
 * 이미지 상·하단 테두리의 색상 균일도를 측정하여 스튜디오 단색 배경 여부를 판별하고 대표 배경색을 반환한다.
 */
export async function analyzeBackdropCleanliness(sourcePath) {
  try {
    const {data, info} = await sharp(sourcePath)
      .rotate()
      .resize(96, 128, {fit: 'fill'})
      .removeAlpha()
      .raw()
      .toBuffer({resolveWithObject: true});

    const w = info.width;
    const h = info.height;
    const sampleRows = (startY, endY) => {
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      const pixels = [];
      for (let y = startY; y < endY; y++) {
        for (let x = 0; x < w; x++) {
          // 중앙 인물 머리/발이 닿을 수 있는 정중앙 24%는 제외하고 좌우 가장자리 위주로 배경색 추출
          if (x > w * 0.38 && x < w * 0.62) continue;
          const idx = (y * w + x) * 3;
          const r = data[idx], g = data[idx + 1], b = data[idx + 2];
          rSum += r; gSum += g; bSum += b; count++;
          pixels.push([r, g, b]);
        }
      }
      if (!count) return {r: 245, g: 245, b: 245, std: 99};
      const mr = rSum / count, mg = gSum / count, mb = bSum / count;
      let varSum = 0;
      for (const [r, g, b] of pixels) {
        varSum += ((r - mr) ** 2 + (g - mg) ** 2 + (b - mb) ** 2) / 3;
      }
      return {
        r: Math.round(mr),
        g: Math.round(mg),
        b: Math.round(mb),
        std: Math.sqrt(varSum / count),
      };
    };

    const top = sampleRows(0, 6);
    const bottom = sampleRows(h - 6, h);
    const colorDiff = Math.hypot(top.r - bottom.r, top.g - bottom.g, top.b - bottom.b);
    const isCleanStudio = top.std < 14 && bottom.std < 18 && colorDiff < 28;
    const studioScore = Math.max(0, 100 - (top.std * 2.2 + bottom.std * 1.8 + colorDiff * 0.9));
    return {isCleanStudio, studioScore, top, bottom};
  } catch {
    return {isCleanStudio: false, studioScore: 0, top: {r: 244, g: 244, b: 244}, bottom: {r: 244, g: 244, b: 244}};
  }
}

/**
 * 수집된 이미지 중 Google Flow 시작 프레임(대표 1번)으로 가장 적합한 전신 스튜디오 착용 컷을 우선 정렬한다.
 * (단, 사용자가 직접 순서를 변경한 경우 preserveOrder=true 이면 사용자 순서를 100% 존중한다.)
 */
export async function selectBestFlowReferences(imageAssets = [], {preserveOrder = false, maxCount = 4} = {}) {
  if (!imageAssets.length) return [];
  if (preserveOrder) return imageAssets.slice(0, maxCount);

  const scored = await Promise.all(imageAssets.map(async (asset, idx) => {
    const bg = await analyzeBackdropCleanliness(asset.filePath);
    // 공식몰 모델 착용 컷이면서 깔끔한 단색 스튜디오 배경(전신 정면 룩북 컷)일수록 최우선 순위 부여
    const kindBonus = asset.kind === 'official' ? 100 : 40;
    const studioBonus = bg.isCleanStudio ? (50 + bg.studioScore * 0.4) : (bg.studioScore * 0.15);
    const orderTieBreak = Math.max(0, 10 - idx * 2);
    return {asset, score: kindBonus + studioBonus + orderTieBreak, bg};
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxCount).map(s => s.asset);
}

/**
 * 원본 100% 무손상 원칙:
 * - 더러운 상하 블러(얼룩) 패딩을 절대 사용하지 않는다!
 * - 깔끔한 스튜디오 배경 사진은 실제 상·하단 배경 픽셀 컬러를 이음새 없이 연장해 완벽한 9:16 화보 비율(1080x1920)로 만든다.
 * - 실내/야외/매장 배경 사진은 억지 여백 합성 없이 원본 비율 그대로 고화질 저장하여 AI가 얼룩을 오인식하지 않게 한다.
 */
export async function prepareFlowReferenceImage(sourcePath, outputPath, {isCutout = false, studioTone = '#efeae2'} = {}) {
  await mkdir(path.dirname(outputPath), {recursive: true});
  const W = 1080;
  const H = 1920;

  if (isCutout) {
    const fg = await sharp(sourcePath)
      .rotate()
      .resize({width: 940, height: 1560, fit: 'inside', withoutEnlargement: false})
      .png()
      .toBuffer();

    const bgSvg = Buffer.from(`
      <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="g" cx="50%" cy="42%" r="65%">
            <stop offset="0%" stop-color="#faf8f5"/>
            <stop offset="100%" stop-color="${studioTone}"/>
          </radialGradient>
        </defs>
        <rect width="${W}" height="${H}" fill="url(#g)"/>
      </svg>
    `);

    await sharp(bgSvg)
      .composite([{input: fg, gravity: 'center'}])
      .jpeg({quality: 95})
      .toFile(outputPath);
    return outputPath;
  }

  const bgInfo = await analyzeBackdropCleanliness(sourcePath);
  if (bgInfo.isCleanStudio) {
    const resized = await sharp(sourcePath)
      .rotate()
      .resize({width: W, height: H, fit: 'inside', withoutEnlargement: false})
      .toBuffer({resolveWithObject: true});

    const padTotal = Math.max(0, H - resized.info.height);
    const padTop = Math.floor(padTotal / 2);
    const padBottom = padTotal - padTop;
    const padHoriz = Math.max(0, W - resized.info.width);
    const padLeft = Math.floor(padHoriz / 2);
    const padRight = padHoriz - padLeft;

    await sharp(resized.data)
      .extend({
        top: padTop,
        bottom: padBottom,
        left: padLeft,
        right: padRight,
        extendWith: 'copy', // 최상단/최하단 실제 스튜디오 픽셀 행을 그대로 연장해 수평 경계선 0% 달성!
      })
      .jpeg({quality: 95})
      .toFile(outputPath);
    return outputPath;
  }

  // 실내 무드컷이나 매장 마네킨 샷은 지저분한 블러 패딩 없이 원본 그대로 깨끗하게 전달
  await sharp(sourcePath)
    .rotate()
    .resize({width: 1440, height: 1920, fit: 'inside', withoutEnlargement: true})
    .jpeg({quality: 95})
    .toFile(outputPath);

  return outputPath;
}

export const GARMENT_CATEGORIES = {
  top: {id: 'top', label: '상의 (티셔츠·니트·셔츠·맨투맨·후드)'},
  outer: {id: 'outer', label: '아우터 (패딩·자켓·코트·집업·가디건)'},
  bottom: {id: 'bottom', label: '하의 (팬츠·데님·슬랙스·조거·스커트)'},
};

/**
 * 상품명과 확인된 설명을 분석하여 'bottom'(하의) | 'outer'(아우터) | 'top'(상의)를 정확히 판별한다.
 */
export function classifyGarmentCategory(product = {}) {
  const nameText = `${product.name || ''} ${product.rawName || ''} ${product.headline || ''}`.trim();
  const fullText = `${nameText} ${Array.isArray(product.sellingPoints) ? product.sellingPoints.join(' ') : ''}`;

  if (/(?:팬츠|바지|슬랙스|데님|청바지|진\b|조거|치노|카고|쇼츠|반바지|하프팬츠|스커트|치마|레깅스|트라우저|와이드핏\s*팬츠|스웻\s*팬츠|트레이닝\s*팬츠|pants|jeans|slacks|skirt|shorts|trouser|jogger|chino)/i.test(nameText)) {
    return 'bottom';
  }
  if (/(?:패딩|다운|푸퍼|점퍼|자켓|재킷|코트|집업|가디건|베스트|조끼|블루종|야상|트렌치|무스탕|아우터|파카|윈드브레이커|바람막이|플리스\s*집업|후드\s*집업|jacket|coat|padding|down|jumper|cardigan|vest|zip-?up|outer)/i.test(nameText)) {
    return 'outer';
  }
  if (/(?:티셔츠|니트|스웨터|맨투맨|스웻셔츠|후드티|후디|후드|셔츠|블라우스|폴로|카라티|긴팔|반팔|크루넥|터틀넥|목폴라|라운드넥|풀오버|탑|이너|shirt|knit|sweater|hoodie|sweatshirt|tee|polo|blouse)/i.test(nameText)) {
    return 'top';
  }
  if (/(?:다리\s*라인|허벅지|밑단까지\s*일자|허리\s*밴드|스트링\s*디테일|하의)/i.test(fullText)) {
    return 'bottom';
  }
  if (/(?:충전재|보온성|레이어드|퀼팅|아우터)/i.test(fullText)) {
    return 'outer';
  }
  return 'top';
}

/**
 * 의류 구분과 상품 특성에 가장 잘 어울리는 기본 연출 프리셋 ID를 자동 추천한다.
 * - 스판/신축성이 확인된 하의는 '앉았다 일어나도 편한 스판 신축성'을 우선 추천한다.
 */
export function recommendDefaultPreset(category, product = {}) {
  const nameText = `${product.name || ''} ${product.rawName || ''}`;
  const fullText = `${nameText} ${product.material || ''} ${Array.isArray(product.sellingPoints) ? product.sellingPoints.join(' ') : ''}`;
  if (category === 'bottom') {
    if (/스판|신축성|폴리우레탄|엘라스틴|스트레치/i.test(fullText)) return 'bottom-sit-stand-span';
    if (/슬랙스|치노/i.test(nameText)) return 'bottom-office-slacks';
    return 'bottom-fit-silhouette';
  }
  if (category === 'outer') return 'top-outer-volume';
  if (/셔츠|블라우스|폴로/i.test(nameText)) return 'top-shirt-clean';
  if (/후드|맨투맨|스웻/i.test(nameText)) return 'top-hoodie-casual';
  if (/니트|스웨터/i.test(nameText)) return 'top-drape-knit';
  return 'top-signature-lookbook';
}

/**
 * 30종 프리셋 문구 속 부위 표현이 의류 구분(특히 하의 vs 상의/아우터)과 어긋나지 않도록 자동 정교화한다.
 */
function adaptPresetPromptForGarment(presetPrompt, category) {
  let text = String(presetPrompt || '');
  if (category === 'bottom') {
    text = text
      .replace(/전신에서 상반신 방향으로/g, '전신에서 허리선~다리 라인 중심으로')
      .replace(/전신에서 상반신까지/g, '전신에서 허리선~허벅지·밑단 라인까지')
      .replace(/상반신 클로즈업 구도에서/g, '허리선과 다리 핏이 잘 보이는 미디엄 샷에서')
      .replace(/상반신 핵심 디테일까지/g, '허리 밴딩·허벅지·밑단 핵심 핏까지')
      .replace(/허리 위 상반신 프레임 안에서/g, '허리선부터 발끝까지 하의가 주인공이 되는 프레임 안에서')
      .replace(/허리 위 미디엄 샷을 중심으로/g, '허리선부터 밑단까지 다리 전체가 보이는 쓰리쿼터·전신 구도로')
      .replace(/무릎 위 미디엄 풀샷에서/g, '머리부터 발끝까지 바지 전체가 보이는 풀샷에서')
      .replace(/가슴·카라 영역으로/g, '허리선·포켓·바지 원단 조직 영역으로')
      .replace(/어깨선,\s*소매 통,\s*옆 실루엣과 총기장 떨어짐/g, '허리선, 골반·허벅지 통 넓이, 옆 실루엣과 밑단 떨어짐')
      .replace(/어깨선과 소매 외곽 라인/g, '바지 옆 봉제선과 밑단 외곽 라인')
      .replace(/어깨선과 깔끔하게 떨어지는 핏/g, '허리선과 일자로 깔끔하게 떨어지는 바지 핏')
      .replace(/소매 끝단이나 카라·앞여밈 라인을 한 손으로 가볍고 우아하게 정돈한 뒤/g, '바지 주머니와 허리선·스트링 주변을 한 손으로 가볍게 정돈한 뒤')
      .replace(/옷깃을 포근하게 여미거나/g, '주머니에 가볍게 손을 넣거나 자연스럽게 걸으며')
      .replace(/넥라인,\s*어깨 재봉선,\s*가슴 핏/g, '허리 밴딩·스트링, 포켓 마감, 허벅지~밑단 핏')
      .replace(/넥라인·앞여밈·단추·지퍼·재봉선 마감/g, '허리 밴딩·스트링·포켓·옆 봉제선·밑단 마감')
      .replace(/상단 카라·어깨 봉제 디테일/g, '허리선·포켓·다리 실루엣 디테일')
      .replace(/어깨와 팔의 힘을 빼/g, '자연스럽게 한 걸음 체중을 옮기며');
  } else if (category === 'top') {
    text = text
      .replace(/옷자락과 바지 통이/g, '상의 밑단과 소매 라인이')
      .replace(/바지 앞판 중심선과 옆 봉제선,\s*밑단 주름/g, '상의 어깨선과 소매 봉제선, 자연스러운 원단 드레이프');
  } else if (category === 'outer') {
    text = text
      .replace(/바지 앞판 중심선과 옆 봉제선,\s*밑단 주름/g, '아우터의 퀼팅·앞여밈 라인과 입체 볼륨 실루엣');
  }
  return text;
}

/**
 * 원본 보존 + 성별 고정 + 상의/아우터/하의 완전 구분 전용 Google Flow 프롬프트 생성기.
 * 시작 프레임(원본 사진)의 인물·성별·착장 의류를 첫 프레임부터 끝까지 100% 동일하게 고정한다.
 */
export function buildFlowPrompt({product = {}, assets = [], modelId = 'omni-1.2-720p', durationSec = 15, presetId = '', customDirection = '', garmentCategory = 'auto'} = {}) {
  const hasMannequin = assets.some(a => a.kind === 'mannequin');
  const hasOfficial = assets.some(a => a.kind === 'official');
  const itemName = product.name || product.rawName || product.headline || '지오다노 의류 상품';
  const rawGender = String(product.gender || '').trim();
  const resolvedCategory = (garmentCategory && GARMENT_CATEGORIES[garmentCategory])
    ? garmentCategory
    : classifyGarmentCategory(product);
  const categoryLabel = GARMENT_CATEGORIES[resolvedCategory]?.label || '상의';
  const materialNote = product.material ? `원단 질감은 확인된 실제 소재(${product.material})의 조직감, 두께감과 촉감을 그대로 유지해 주세요.` : '';
  const preset = FLOW_PRESETS[presetId] || FLOW_PRESETS[recommendDefaultPreset(resolvedCategory, product)] || FLOW_PRESETS['top-signature-lookbook'];
  const adaptedPresetPrompt = adaptPresetPromptForGarment(preset.prompt, resolvedCategory);
  const customNote = String(customDirection || '').trim();

  let genderLockRule = '[인물·착장 100% 고정] 첨부된 시작 프레임(원본 사진) 속 실제 모델(또는 마네킨)의 성별, 얼굴, 체형, 헤어스타일과 현재 입고 있는 상·하의·신발 전체 착장을 첫 0초부터 마지막까지 100% 동일하게 유지하세요. 절대 다른 사람이나 다른 옷으로 바꾸지 마세요.';
  if (/남성|맨|남자|MEN/i.test(rawGender) && !/공용|유니섹스/i.test(rawGender)) {
    genderLockRule = `[남성 모델·원본 착장 100% 고정] 이 상품(${itemName})은 남성용 의류입니다. 반드시 첨부된 시작 프레임(원본 사진) 속 실제 남성 모델의 얼굴·체형·헤어와 입고 있는 실제 의류 착장을 첫 장면부터 끝까지 100% 동일하게 유지하세요. 절대 여성 모델로 바꾸거나 원본 사진에 없는 다른 옷을 입히지 마세요.`;
  } else if (/여성|우먼|여자|WOMEN/i.test(rawGender) && !/공용|유니섹스/i.test(rawGender)) {
    genderLockRule = `[여성 모델·원본 착장 100% 고정] 이 상품(${itemName})은 여성용 의류입니다. 반드시 첨부된 시작 프레임(원본 사진) 속 실제 여성 모델의 얼굴·체형·헤어와 입고 있는 실제 의류 착장을 첫 장면부터 끝까지 100% 동일하게 유지하세요. 절대 다른 모델이나 원본 사진에 없는 다른 옷으로 바꾸지 마세요.`;
  } else if (/공용|유니섹스|UNISEX/i.test(rawGender)) {
    genderLockRule = `[원본 모델·착장 100% 고정] 남녀공용 상품(${itemName})입니다. 반드시 첨부된 시작 프레임(원본 사진) 속 실제 모델의 성별·얼굴·체형과 현재 입고 있는 실제 의류 착장을 첫 장면부터 끝까지 100% 동일하게 유지하고 다른 옷으로 변형하지 마세요.`;
  }

  let focusAndFramingRule = '';
  let detailPreservationRule = '';

  if (resolvedCategory === 'bottom') {
    focusAndFramingRule = `[하의 주인공 · 구도 고정] 이 상품(${itemName})은 하의(바지/팬츠) 상품입니다. 함께 코디된 상의는 보조 역할일 뿐이며, 반드시 하의(허리선·골반·허벅지·무릎·밑단·신발까지 이어지는 전체 다리 실루엣과 바지 통 핏)가 영상의 중심 주인공이 되도록 촬영하세요. 절대 상반신만 클로즈업해서 바지가 화면 아래로 잘리게 하지 말고, 첫 프레임부터 마지막까지 하의 전체가 또렷하게 보이는 전신·하체 중심 구도를 유지하세요.`;
    detailPreservationRule = `[원본 절대 보존 원칙 · 하의 디테일] 원본 사진 속 하의(${itemName})의 허리 밴딩·스트링·지퍼·버튼, 앞뒤 포켓 위치, 바지 통 넓이, 일자/와이드/조거 떨어짐, 기장, 밑단 마감, 실제 색상을 단 1%도 변형·추가·생략하지 마세요. 모델이 천천히 걷거나 반회전할 때 바지 원단이 자연스럽게 흔들리고 복원되는 실제 착용 핏을 보여주세요.`;
  } else if (resolvedCategory === 'outer') {
    focusAndFramingRule = `[아우터 주인공 · 구도 고정] 이 상품(${itemName})은 아우터(겉옷) 상품입니다. 아우터 특유의 입체적인 볼륨감, 어깨선, 앞여밈(지퍼·단추), 카라·후드 형태, 포켓, 전체 기장감과 이너와의 레이어드 핏이 가장 돋보이도록 전신~쓰리쿼터(무릎 위) 중심 구도로 촬영하세요.`;
    detailPreservationRule = `[원본 절대 보존 원칙 · 아우터 디테일] 원본 사진 속 아우터(${itemName})의 퀼팅·절개선, 칼라·후드 모양, 지퍼·스냅·단추 개수와 위치, 소매 커프스, 포켓, 기장 비율과 실제 색감을 단 1%도 변형·추가·생략하지 마세요. 팔과 상체를 부드럽게 움직일 때 아우터의 가벼운 탄성과 입체감이 자연스럽게 드러나게 해주세요.`;
  } else {
    focusAndFramingRule = `[상의 주인공 · 구도 고정] 이 상품(${itemName})은 상의 상품입니다. 함께 코디된 하의는 보조 역할일 뿐이며, 반드시 상의(넥라인·카라, 어깨선, 소매 통, 가슴·몸통 핏, 밑단 시보리/기장, 원단 짜임)가 영상의 중심 주인공이 되도록 전신에서 허리선 위 상반신 중심으로 자연스럽게 시선이 모이는 구도로 촬영하세요.`;
    detailPreservationRule = `[원본 절대 보존 원칙 · 상의 디테일] 원본 사진 속 상의(${itemName})의 넥라인·카라 형태, 어깨 드롭 라인, 소매 길이와 통, 앞여밈·단추·포켓, 밑단 마감, 실제 색감을 단 1%도 변형·추가·생략하지 마세요. 모델의 호흡과 자연스러운 팔·상체 움직임에 따라 원단이 부드럽게 흐르는 실제 착용감을 보여주세요.`;
  }

  const verifiedFitHints = Array.isArray(product.sellingPoints)
    ? product.sellingPoints.map(s => String(s || '').trim()).filter(Boolean).slice(0, 2)
    : [];
  const verifiedFitLine = verifiedFitHints.length
    ? `[확인된 실제 상품 포인트 반영] ${verifiedFitHints.join(' / ')} — 위 확인된 특징이 과장 없이 자연스럽게 드러나도록 연출해 주세요.`
    : '';

  const refLabels = [
    hasOfficial ? '공식몰 모델 착용 원본 컷' : null,
    hasMannequin ? '매장 마네킨 실물 정면 컷' : null,
  ].filter(Boolean).join(', ') || '원본 상품 착용 사진';

  const promptKo = [
    `[프로젝트 목표] 첨부된 시작 프레임(${refLabels})을 그대로 이어받아 자연스럽게 살아 움직이는 9:16 세로형 프리미엄 패션 브랜드 실사 룩북 영상(${Math.round(durationSec)}초)을 제작해 주세요.`,
    genderLockRule,
    focusAndFramingRule,
    detailPreservationRule,
    materialNote,
    verifiedFitLine,
    adaptedPresetPrompt,
    customNote ? `[추가 디렉팅 · 원본 인물/의류 변형 금지] ${customNote}` : '',
    `[화면 청결 규칙] 영상 내부에 어떠한 글자, 자막, 숫자, 워터마크, 임의 로고, 분할 화면, 과도한 색보정 필터도 절대 생성하지 마세요.`
  ].filter(Boolean).join('\n\n');

  const refDesc = hasOfficial ? '공식몰 전신 모델 착용 원본 사진 (시작 프레임 100% 고정)' : (hasMannequin ? '매장 마네킨 정면 실물 사진 (시작 프레임 100% 고정)' : '원본 상품 사진 고정');
  const summaryKo = [
    `엔진: ${(FLOW_MODELS[modelId] || FLOW_MODELS['omni-1.2-720p']).label} (${Math.round(durationSec)}초 · 예상 약 ${estimateFlowCredits(modelId, durationSec)}크레딧)`,
    `의류 맞춤 설정: ${categoryLabel}${rawGender ? ` · 성별 고정: ${rawGender}` : ''}`,
    `연출 프리셋: ${preset.label} · 생성 방식: 시작 프레임 100% 고정`,
    `참고자료: ${refDesc}`,
  ].join('\n');

  return {promptEn: promptKo, summaryKo, resolvedCategory};
}

let activeBrowser = null;
let activeContext = null;
let activePage = null;
const FLOW_CDP_PORT = 9229;

async function waitForCdpReady(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(1200)});
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 350));
  }
  return false;
}

function launchVisibleChromeProcess(chromeExe, profileDir, port, initialUrl) {
  const child = spawn(chromeExe, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    initialUrl,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.on('error', () => {});
  child.unref();
}

export async function ensureFlowChrome(profileDir, log = () => {}) {
  await mkdir(profileDir, {recursive: true});

  // 이미 떠 있는 전용 Chrome(CDP 9229)에 먼저 재연결 시도
  if (!activeBrowser || !activeBrowser.isConnected()) {
    const alreadyUp = await waitForCdpReady(FLOW_CDP_PORT, 900);
    if (!alreadyUp) {
      const systemChrome = findSystemChrome();
      if (!systemChrome) {
        throw new Error('이 PC에서 Google Chrome을 찾지 못했습니다. Chrome 설치 후 다시 시도해 주세요.');
      }
      log('실제 Google Chrome(전용 프로필) 창을 화면에 여는 중…');
      launchVisibleChromeProcess(systemChrome, profileDir, FLOW_CDP_PORT, FLOW_URL);
      const ready = await waitForCdpReady(FLOW_CDP_PORT, 18000);
      if (!ready) {
        throw new Error('Google Chrome 창 연결 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.');
      }
    }
    activeBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${FLOW_CDP_PORT}`);
    activeBrowser.on('disconnected', () => {
      activeBrowser = null;
      activeContext = null;
      activePage = null;
    });
  }

  activeContext = activeBrowser.contexts()[0];
  if (!activeContext) throw new Error('Chrome 브라우저 컨텍스트를 열지 못했습니다.');
  const pages = activeContext.pages();
  activePage = pages.find(p => /^https:\/\/(?:labs\.google\/|flow\.google\.com)/i.test(p.url())) || pages[0] || await activeContext.newPage();
  await activePage.bringToFront().catch(() => {});
  return {context: activeContext, page: activePage};
}

function openInUserBrowser(url) {
  if (process.platform === 'win32') {
    const child = spawn('explorer.exe', [url], {detached: true, stdio: 'ignore'});
    child.on('error', () => {});
    child.unref();
    return;
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [url], {detached: true, stdio: 'ignore'});
  child.on('error', () => {});
  child.unref();
}

function copyTextToClipboard(text) {
  if (process.platform !== 'win32' || !text) return;
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-WindowStyle', 'Hidden',
      '-Command',
      '[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())',
    ], {stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true});
    child.on('error', () => {});
    child.stdin.write(text, 'utf8');
    child.stdin.end();
  } catch {}
}

/**
 * 사용자의 실제 기본 Chrome 창에 Google Flow(https://flow.google.com/)를 확실하게 열고,
 * 한국어 원본 보존 프롬프트를 클립보드에 자동 복사하며 9:16 준비 폴더도 바로 쓸 수 있게 준비한다.
 */
export async function launchAndPrepareFlow({
  preparedImagePaths = [],
  promptEn = '',
  modelId = 'omni-1.2-720p',
  downloadsDir,
  log = () => {},
}) {
  if (downloadsDir) await mkdir(downloadsDir, {recursive: true});

  if (promptEn) {
    copyTextToClipboard(promptEn);
    log('한국어 원본 보존 프롬프트를 클립보드에 자동 복사했습니다. (Flow에서 Ctrl+V로 바로 붙여넣기 가능)');
  }

  log('Google Flow용 9:16 참고 이미지와 한국어 프롬프트 준비 완료.');

  const modelInfo = FLOW_MODELS[modelId] || FLOW_MODELS['omni-1.2-720p'];
  const actions = [
    '새 탭으로 Google Flow(flow.google.com)가 열렸습니다.',
    '한국어 원본 보존 프롬프트가 클립보드에 자동 복사되었습니다. (Flow에서 Ctrl+V)',
    preparedImagePaths.length
      ? `9:16 참고 이미지 ${preparedImagePaths.length}장이 준비되었습니다. [9:16 준비 폴더 열기]에서 Flow로 끌어다 놓으세요.`
      : '참고 이미지를 먼저 불러온 뒤 Flow로 끌어다 놓으세요.',
  ];

  return {
    status: 'ready',
    message: `Google Flow를 열었습니다! (${modelInfo.label}) Flow에서 생성·다운로드 후 [2. 최신 Flow 영상 불러오기]를 누르면 1초 만에 불러옵니다.`,
    actions,
    url: FLOW_URL,
  };
}

/**
 * Flow 전용 다운로드 폴더 또는 PC 기본 Downloads 폴더에서 가장 최근 MP4 영상을 찾아 작업 폴더로 복사한다.
 * (원본 파일은 절대 삭제·수정하지 않고 복사본만 사용)
 */
export async function importLatestFlowVideo(flowDownloadsDir, destSourcesDir, {maxAgeMs = 45 * 60 * 1000} = {}) {
  const candidatesDirs = [
    flowDownloadsDir,
    path.join(os.homedir(), 'Downloads'),
  ].filter(dir => dir && fs.existsSync(dir));

  const now = Date.now();
  let latest = null;
  for (const dir of candidatesDirs) {
    try {
      const entries = await readdir(dir, {withFileTypes: true});
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.(mp4|mov|webm)$/i.test(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const st = await stat(full);
        if (maxAgeMs && (now - st.mtimeMs) > maxAgeMs) continue;
        if (!latest || st.mtimeMs > latest.mtimeMs) {
          latest = {full, name: entry.name, mtimeMs: st.mtimeMs, size: st.size};
        }
      }
    } catch {}
  }

  if (!latest) {
    throw new Error('최근 45분 이내에 새로 다운로드된 Flow 동영상 파일(MP4)이 없습니다. Flow 화면의 영상 카드 우측 상단 [⋮] → [다운로드] 후 다시 눌러주세요.');
  }

  await mkdir(destSourcesDir, {recursive: true});
  const ext = path.extname(latest.name) || '.mp4';
  const safeBase = `flow-${Date.now()}${ext}`;
  const destPath = path.join(destSourcesDir, safeBase);
  await copyFile(latest.full, destPath);

  return {
    filePath: destPath,
    filename: safeBase,
    originalName: latest.name,
    size: latest.size,
  };
}

export async function closeFlowChrome() {
  if (activeBrowser) {
    await activeBrowser.close().catch(() => {});
    activeBrowser = null;
    activeContext = null;
    activePage = null;
  }
}
