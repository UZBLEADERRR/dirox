/**
 * Interface strings.
 *
 * The interface is English; the assistant is not. What the model writes —
 * lessons, chapters, chat replies, the text inside a generated app — follows
 * whoever it is talking to. Keeping the chrome in one language keeps the
 * product legible to everyone who might publish to the market, and keeps the
 * strings in one place rather than three.
 */

const T = {
  market:'Market', chat:'Chat', all:'All', popular:'Popular', newest:'New',
  get:'GET', install:'Install', installed:'installed', installs:'installs',
  size:'Size', added:'Added', loading:'Loading…', category:'Category',
  nothingFound:'Nothing found', marketEmpty:'The market is empty.\nBe the first to publish.',
  heroTitle:'Build your own app', heroSub:'Say what you need — the AI writes it, tests it, and puts it on your screen.',
  heroCta:'Start building',
  marketPublish:'Publish to market', marketSend:'Publish',
  marketHow:'The AI reviews your app: does it work, is it useful, where does it belong. If it passes, it goes live and anyone can install it.',
  marketLive:'Done — your app is in the market.', marketPending:'Submitted. It appears after review.',
  dailyLimit:'One app a day. Try again tomorrow.',
  reviewStart:'Start AI review', reviewing:'The AI is reviewing…',
  reviewPassed:'Passed review', reviewFailed:'Not accepted',
  author:'Author', authorHint:'Shown next to your app.',
  marketUrl:'Market server',

  signIn:'Sign in', signUp:'Create account', signOut:'Sign out', account:'Account',
  fillAll:'Enter a username and password',
  authFine:'We ask for no email, so a password cannot be reset. Write it down.',
  published:'published', leftToday:'left today', daysLeft:'days left',
  inactiveNote:'An account unused for {n} days is deleted. Signing in resets the count. Apps you published stay in the market.',
  changePassword:'Change password', currentPassword:'Current password', newPassword:'New password',
  signOutNote:'Your chats and apps stay on this phone.',
  deleteAccount:'Delete account',
  deleteAccountNote:'The account is gone for good. Apps you published stay in the market.',
  loginToPublish:'Sign in to publish',

  newChat:'New chat', settings:'Settings', apps:'My apps', chats:'Chats',
  today:'Today', week:'This week', older:'Earlier',
  ask:'What are we building?', send:'Send', stop:'Stop',
  emptyTitle:'Hi', emptySub:'Build an app, a course, or a book. Ask in any language.',
  noKeyTitle:'API key needed', noKeySub:'Enter your own key to start. It stays on this phone only.',
  addKey:'Add key',
  apiKey:'API key', baseUrl:'API base URL', model:'Model', chooseModel:'Choose a model',
  searchModel:'Search models…', loadModels:'Load models', noModels:'No models found',
  role:'Role', roles:'Roles', newRole:'New role', roleName:'Name', rolePrompt:'System prompt',
  roleTools:'Can build', roleToolsSub:'Write files, run checks, publish',
  theme:'Appearance', dark:'Dark', light:'Light', system:'System',
  save:'Save', cancel:'Cancel', delete:'Delete', rename:'Rename',
  open:'Open', edit:'Edit', done:'Done', close:'Close', copy:'Copy', copied:'Copied',
  installPwa:'Install to home screen', installSub:'One tap from your phone screen',
  installIos:'Tap Share → Add to Home Screen', later:'Later',
  addToHome:'Add to home screen', appName:'Name', icon:'Icon', color:'Colour',
  publish:'Save as app', appAdded:'Added', update:'Update',
  noApps:'Nothing here yet.\nTry: "build me a calculator".',
  deviceAccess:'Camera & microphone', deviceWarn:'Warning: such an app can read your API key. Enable only for apps you trust.',
  usage:'Used', tokens:'tokens', storage:'Storage', clearAll:'Delete everything',
  confirmDelete:'Delete?', yes:'Yes', no:'No',
  error:'Error', retry:'Retry', share:'Share', code:'Code', preview:'Preview',
  ideas:['Expense tracker', 'IELTS course', 'Snake game', 'A book about coffee'],
  print:'Save as PDF', attach:'Attach', reading:'Reading document…',
  attached:'attached', pages:'pages', words:'words',
  sourceTooBig:'That document is very large — only the first part will be used.',
  unsupportedFile:'Unsupported file. Use PDF, EPUB, TXT, MD or HTML.',
  steps:{ write:'File written', edit:'File patched', read:'File read', list:'Files',
          check:'Checked', shot:'Screenshot', publish:'Saved', asset:'Image added',
          outline:'Outline', lesson:'Lesson', chapter:'Chapter', cover:'Cover', source:'Source',
          sub:'Writer' },
};

export function t(key) {
  return key.split('.').reduce((o, k) => (o || {})[k], T) ?? key;
}
