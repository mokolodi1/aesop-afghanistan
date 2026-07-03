/** @typedef {'en'|'fa'} PortalLocale */

const PORTAL_LOCALE_STORAGE_KEY = 'portalLocale';

/** @type {Record<PortalLocale, Record<string, string>>} */
const TRANSLATIONS = {
  en: {
    'language.toggleAria': 'Switch portal language',
    'language.switchToDari': 'دری',
    'language.switchToEnglish': 'English',

    'nav.profile': 'Profile',
    'nav.editDing': 'Edit Ding',
    'nav.admin': 'Admin',
    'nav.compose': 'Compose',
    'nav.campaigns': 'Campaigns',
    'nav.reviewApplications': 'Review Applications',
    'nav.portalNav': 'Portal navigation',

    'header.studentPortal': 'Student Portal',
    'header.taglineEducation': 'Education',
    'header.taglineService': 'Service',
    'header.taglineCommunity': 'Community',
    'header.fullName': 'Full name',
    'header.aesopId': 'AESOP ID',
    'header.email': 'Email',
    'header.class': 'Class',
    'header.grade': 'Grade',
    'header.teaching': 'Teaching',
    'header.category': 'Category',
    'header.logOff': 'Log off',
    'header.yourProfile': 'Your profile',
    'header.homeAria': 'AESOP Afghanistan Student Portal — home',

    'hub.welcomeNamed': 'Welcome, {{name}}!',
    'hub.welcomeApplicant': 'Applicant',
    'hub.welcomeStudent': 'Student',
    'hub.yourAccount': 'Your account',
    'hub.dingNumber': 'Ding number',
    'hub.notSetYet': 'Not set yet',
    'hub.phoneOnFile': 'Phone on file',
    'hub.applicationStatus': 'Application Status',
    'hub.aboutPortal': 'About this portal',
    'hub.aboutApplicantPrefix':
      'This secure applicant portal is where you sign in with a magic link—there is no password to remember on this site. Check your application status, Round 2 voice memo, and the application calendar here, and read',
    'hub.aboutStudentPrefix':
      'This secure student portal is where you sign in with a magic link—there is no password to remember on this site. Use it to update your Afghanistan Ding phone number when it changes (with confirmation), review past Ding updates, request help if you need a non-Afghan number for Ding, and read',
    'hub.aboutStudentSuffix':
      'Your AESOP ID, email, and Ding number above summarize what we have on file—open',
    'hub.aboutStudentEnd': 'to change your Ding number.',
    'hub.aboutGuestLine1':
      'The AESOP Student Portal helps you update your Afghanistan Ding number, see Ding number history after you sign in, and read FAQs—using a magic link, not a password on this site.',
    'hub.aboutGuestSectionsLead': 'Portal sections:',
    'hub.aboutGuestAnd': 'and',
    'hub.aboutGuestNotConnected': 'Not connected?',
    'hub.aboutGuestRequestAbove': 'above with your AESOP ID.',
    'hub.preferMainSite': 'Prefer the main site?',
    'hub.profileIntro':
      'Sign in with your magic link to update your Afghanistan Ding number, view history, or request help with a non-Afghan number.',
    'hub.faqLink': 'frequently asked questions',
    'hub.studentPortalTitle': 'Student Portal',
    'hub.signInHeading': 'Connect with your AESOP ID',
    'hub.signInLead':
      'Enter the student ID AESOP gave you. We\'ll email a magic link; open it on this device to finish signing in.',
    'hub.readFaqs': 'Read FAQs',

    'applicationStatus.accepted': 'Your application is accepted for Round 1 selection.',
    'applicationStatus.rejected': 'You are rejected, please apply next year.',
    'applicationStatus.pending': 'Pending',

    'role.applicant': 'Applicant',
    'role.student': 'Student',
    'role.teacher': 'Teacher',
    'role.admin': 'Admin',

    'voiceMemo.checking': 'Checking voice memo status…',
    'voiceMemo.submitted': 'Submitted',
    'voiceMemo.notSubmitted': 'Not submitted yet',
    'voiceMemo.pendingNote':
      'Your voice note takes 1 to 48 hours to be visible if you have already submitted it.',
    'voiceMemo.label': 'Voice memo',
    'voiceMemo.submittedOn': 'Submitted on',
    'voiceMemo.recordingLength': 'Recording length',
    'voiceMemo.audioUnavailable':
      'Your submission is recorded, but the audio file is not available to play yet. Please check again later.',
    'voiceMemo.audioPlayError':
      'Could not play your voice memo. Please try again or contact support.',
    'voiceMemo.submissionDefault':
      'Submit your Round 2 voice memo using the instructions you received by email. Once it is received, this page will show Submitted and you can listen to your recording here.',
    'voiceMemo.loadError': 'Could not load voice memo status.',
    'voiceMemo.networkError': 'Network error. Please try again.',
    'voiceMemo.sectionAria': 'Round 2 voice memo',
    'voiceMemo.accordionAria': 'Voice memo',
    'voiceMemo.audioUnsupported': 'Your browser does not support audio playback.',
    'voiceMemo.tooShort':
      'Your voice memo is shorter than {{minSeconds}} seconds. Please record again and resubmit a memo between {{minSeconds}} seconds and {{maxMinutes}} minutes. Applications with voice memos shorter than {{minSeconds}} seconds will be rejected immediately.',
    'voiceMemo.tooLong':
      'Your voice memo is longer than {{maxMinutes}} minutes. Please record again and resubmit a memo between {{minSeconds}} seconds and {{maxMinutes}} minutes.',

    'calendar.label': 'Calendar',
    'calendar.loading': 'Loading calendar…',
    'calendar.empty': 'No application dates are listed yet.',
    'calendar.process': 'Application process',
    'calendar.date': 'Date',
    'calendar.networkError': 'Network error. Please try again.',
    'calendar.loadError': 'Could not load calendar.',
    'calendar.sectionAria': 'Application calendar',
    'calendar.accordionAria': 'Calendar',

    'magicLink.aesopId': 'AESOP ID',
    'magicLink.enterId': 'Enter your ID',
    'magicLink.rememberId': 'Remember my ID',
    'magicLink.submit': 'Email me a magic link',
    'magicLink.invalidId': 'Please enter a valid ID.',
    'magicLink.sending': 'Checking ID and sending magic link...',
    'magicLink.networkError': 'Internal error. Please try again.',

    'profile.applicantBlockedTitle': 'Not available for applicants',
    'profile.applicantBlockedPrefix':
      'Ding number updates are for enrolled students and teachers only. Return to',
    'profile.applicantBlockedSuffix': 'to view your application information.',
    'profile.sessionIncompleteTitle': 'Session incomplete',
    'profile.sessionIncompletePrefix': 'Go back to',
    'profile.sessionIncompleteSuffix': 'and connect with your AESOP ID so we can load your account.',
    'profile.backToProfile': 'Profile',

    'intent.signInProfileTitle': 'Sign in to manage your Ding number',
    'intent.signInGenericTitle': 'Sign in for account-specific help',
    'intent.openedLink': 'You opened a link related to {{title}}.',
    'intent.requestMagicLink': 'Request a magic link',
    'intent.magicLinkHelpBeforeFaq': 'with your AESOP ID—we\'ll email you a one-time link. The',
    'intent.magicLinkHelpAfterFaq': 'page does not require signing in.',
    'intent.editDing': 'Edit Ding',
    'intent.faq': 'FAQs',

    'reviews.pageTitle': 'Review Applications',
    'reviews.pageLead': 'Review essays, set English level, and score fitness for the program.',
    'reviews.loading': 'Loading applications…',
    'reviews.loadError': 'Could not load review assignments.',
    'reviews.empty': 'No applications are assigned to you for review.',
    'reviews.accessDenied': 'Reviewer access is required to view this page.',
    'reviews.applicantId': 'AESOP ID',
    'reviews.appliedLevel': 'Applied level',
    'reviews.notAvailable': 'Not listed',
    'reviews.essayLabel': 'Essay',
    'reviews.essayMissing': 'No essay on file.',
    'reviews.playVoice': 'Play voice note',
    'reviews.voiceComingSoon': 'Coming soon',
    'reviews.levelLabel': 'English Level',
    'reviews.suspectedAi': 'Suspected AI',
    'reviews.suspectedAiFlagged': 'Suspected AI — Flagged',
    'reviews.suspectedAiOffHint': 'Mark if the essay may be AI-written',
    'reviews.fitnessLabel': 'Fitness for Program',
    'reviews.fitness.instruction': 'Instruction following',
    'reviews.fitness.original': 'Original thinking',
    'reviews.fitness.character': 'Character',
    'reviews.rubric.moreInfo': 'Scoring guide',
    'reviews.rubric.highestLabel': 'Highest',
    'reviews.rubric.adequateLabel': 'Adequate',
    'reviews.rubric.lowLabel': 'Low',
    'reviews.rubric.instructionFollowing.title': 'Instruction Following',
    'reviews.rubric.instructionFollowing.highest':
      'The student has correctly understood and followed instructions from the prompts.',
    'reviews.rubric.instructionFollowing.adequate':
      'There is some misunderstanding of the instructions or prompts.',
    'reviews.rubric.instructionFollowing.low':
      'The student has not understood or followed the instructions, or does not discuss the prompt.',
    'reviews.rubric.originalThinking.title': 'Independent / Original Thinking',
    'reviews.rubric.originalThinking.highest':
      'The student shows evidence of original thinking—going beyond clichés or basic facts.',
    'reviews.rubric.originalThinking.adequate': 'The student shows some evidence of original thinking.',
    'reviews.rubric.originalThinking.low':
      "The student's ideas are very basic or clichéd. You've heard this a lot before.",
    'reviews.rubric.character.title': 'Demonstration of Character',
    'reviews.rubric.character.highest':
      'There is clear evidence of a strong personal character that would add to the community. You want this applicant in AESOP.',
    'reviews.rubric.character.adequate':
      'There is some evidence of a strong personal character. They might add something to the community.',
    'reviews.rubric.character.low':
      "There is no real evidence of a strong personal character. You don't feel that this person would add anything to the AESOP community.",
    'reviews.scalePlaceholder': 'Select score…',
    'reviews.scalePlaceholderFor': 'Select {{field}} score',
    'reviews.scale.lowest': 'Lowest',
    'reviews.scale.midpoint': 'Mid-point',
    'reviews.scale.highest': 'Highest',
    'reviews.scoringAria': 'Review scoring',
    'reviews.studentList': 'Applicants',
    'reviews.nextStudent': 'Next student',
    'reviews.savePending': 'Saving soon…',
    'reviews.saveSaving': 'Saving…',
    'reviews.saveSavedJustNow': 'Saved just now',
    'reviews.saveSavedSecondsAgo': 'Saved {{seconds}} seconds ago',
    'reviews.saveSavedMinutesAgo': 'Saved {{minutes}} minute ago',
    'reviews.saveSavedMinutesAgoPlural': 'Saved {{minutes}} minutes ago',
    'reviews.saveStatusError': 'Save failed — will retry',
    'reviews.saveStatusSaving': 'Saving…',
  },
  fa: {
    'language.toggleAria': 'تغییر زبان پورتال',
    'language.switchToDari': 'دری',
    'language.switchToEnglish': 'English',

    'nav.profile': 'پروفایل',
    'nav.editDing': 'تغییر Ding',
    'nav.admin': 'مدیریت',
    'nav.compose': 'نوشتن ایمیل',
    'nav.campaigns': 'کمپین‌ها',
    'nav.reviewApplications': 'بررسی درخواست‌ها',
    'nav.portalNav': 'مسیریابی پورتال',

    'header.studentPortal': 'پورتال محصلین',
    'header.taglineEducation': 'آموزش',
    'header.taglineService': 'خدمت',
    'header.taglineCommunity': 'جامعه',
    'header.fullName': 'نام کامل',
    'header.aesopId': 'AESOP ID',
    'header.email': 'ایمیل',
    'header.class': 'صنف',
    'header.grade': 'نمره',
    'header.teaching': 'تدریس',
    'header.category': 'کتگوری',
    'header.logOff': 'خروج',
    'header.yourProfile': 'پروفایل شما',
    'header.homeAria': 'پورتال محصلین AESOP افغانستان — صفحه اصلی',

    'hub.welcomeNamed': 'خوش آمدید، {{name}}!',
    'hub.welcomeApplicant': 'متقاضی',
    'hub.welcomeStudent': 'محصل',
    'hub.yourAccount': 'حساب شما',
    'hub.dingNumber': 'شماره Ding',
    'hub.notSetYet': 'هنوز ثبت نشده',
    'hub.phoneOnFile': 'شماره تماس ثبت‌شده',
    'hub.applicationStatus': 'وضعیت درخواست',
    'hub.aboutPortal': 'درباره این پورتال',
    'hub.aboutApplicantPrefix':
      'این پورتال امن متقاضیان است که با لینک جادویی وارد می‌شوید — در این سایت رمز عبور وجود ندارد. وضعیت درخواست، یادداشت صوتی دور دوم و تقویم درخواست را اینجا ببینید و',
    'hub.aboutStudentPrefix':
      'این پورتال امن محصلین است که با لینک جادویی وارد می‌شوید — در این سایت رمز عبور وجود ندارد. شماره Ding افغانستان خود را به‌روز کنید، سابقه تغییرات را ببینید، در صورت نیاز به شماره غیرافغانی درخواست کمک کنید و',
    'hub.aboutStudentSuffix':
      'AESOP ID، ایمیل و شماره Ding بالا خلاصه اطلاعات ثبت‌شده است — برای تغییر شماره Ding به',
    'hub.aboutStudentEnd': 'بروید.',
    'hub.aboutGuestLine1':
      'پورتال محصلین AESOP به شما کمک می‌کند شماره Ding افغانستان خود را به‌روز کنید، پس از ورود سابقه تغییرات را ببینید و سوالات متداول را بخوانید — با لینک جادویی، نه رمز عبور در این سایت.',
    'hub.aboutGuestSectionsLead': 'بخش‌های پورتال:',
    'hub.aboutGuestAnd': 'و',
    'hub.aboutGuestNotConnected': 'وصل نیستید؟',
    'hub.aboutGuestRequestAbove': 'بالا با AESOP ID خود درخواست دهید.',
    'hub.preferMainSite': 'ترجیح می‌دهید سایت اصلی را ببینید؟',
    'hub.profileIntro':
      'با لینک جادویی وارد شوید تا شماره Ding افغانستان خود را به‌روز کنید، سابقه را ببینید یا در مورد شماره غیرافغانی درخواست کمک کنید.',
    'hub.faqLink': 'سوالات متداول',
    'hub.studentPortalTitle': 'پورتال محصلین',
    'hub.signInHeading': 'با AESOP ID خود وصل شوید',
    'hub.signInLead':
      'AESOP ID که AESOP به شما داده را وارد کنید. ما یک لینک جادویی ایمیل می‌کنیم؛ آن را روی همین دستگاه باز کنید تا وارد شوید.',
    'hub.readFaqs': 'خواندن سوالات متداول',

    'applicationStatus.accepted': 'درخواست شما برای انتخاب دور اول پذیرفته شده است.',
    'applicationStatus.rejected': 'درخواست شما رد شده است، لطفاً سال آینده دوباره درخواست دهید.',
    'applicationStatus.pending': 'در انتظار',

    'role.applicant': 'متقاضی',
    'role.student': 'محصل',
    'role.teacher': 'معلم',
    'role.admin': 'مدیر',

    'voiceMemo.checking': 'در حال بررسی یادداشت صوتی…',
    'voiceMemo.submitted': 'ثبت شده',
    'voiceMemo.notSubmitted': 'هنوز ثبت نشده',
    'voiceMemo.pendingNote':
      'اگر قبلاً یادداشت صوتی خود را فرستاده‌اید، نمایان شدن آن ۱ تا ۴۸ ساعت زمان می‌برد.',
    'voiceMemo.label': 'یادداشت صوتی',
    'voiceMemo.submittedOn': 'ثبت شده در',
    'voiceMemo.recordingLength': 'مدت ضبط',
    'voiceMemo.audioUnavailable':
      'ارسال شما ثبت شده، اما فایل صوتی هنوز برای پخش در دسترس نیست. لطفاً بعداً دوباره بررسی کنید.',
    'voiceMemo.audioPlayError':
      'پخش یادداشت صوتی ممکن نشد. لطفاً دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.',
    'voiceMemo.submissionDefault':
      'یادداشت صوتی دور دوم را طبق دستورالعمل ایمیل‌شده ارسال کنید. پس از دریافت، این صفحه «ثبت شده» را نشان می‌دهد و می‌توانید ضبط خود را بشنوید.',
    'voiceMemo.loadError': 'بارگذاری وضعیت یادداشت صوتی ممکن نشد.',
    'voiceMemo.networkError': 'خطای شبکه. لطفاً دوباره تلاش کنید.',
    'voiceMemo.sectionAria': 'یادداشت صوتی دور دوم',
    'voiceMemo.accordionAria': 'یادداشت صوتی',
    'voiceMemo.audioUnsupported': 'مرورگر شما از پخش صدا پشتیبانی نمی‌کند.',
    'voiceMemo.tooShort':
      'یادداشت صوتی شما کوتاه‌تر از {{minSeconds}} ثانیه است. لطفاً دوباره ضبط کنید و یادداشتی بین {{minSeconds}} ثانیه تا {{maxMinutes}} دقیقه بفرستید. درخواست‌هایی با یادداشت صوتی کوتاه‌تر از {{minSeconds}} ثانیه فوراً رد می‌شوند.',
    'voiceMemo.tooLong':
      'یادداشت صوتی شما بیش از {{maxMinutes}} دقیقه است. لطفاً دوباره ضبط کنید و یادداشتی بین {{minSeconds}} ثانیه تا {{maxMinutes}} دقیقه بفرستید.',

    'calendar.label': 'تقویم',
    'calendar.loading': 'در حال بارگذاری تقویم…',
    'calendar.empty': 'هنوز تاریخ درخواست ثبت نشده است.',
    'calendar.process': 'مراحل درخواست',
    'calendar.date': 'تاریخ',
    'calendar.networkError': 'خطای شبکه. لطفاً دوباره تلاش کنید.',
    'calendar.loadError': 'بارگذاری تقویم ممکن نشد.',
    'calendar.sectionAria': 'تقویم درخواست',
    'calendar.accordionAria': 'تقویم',

    'magicLink.aesopId': 'AESOP ID',
    'magicLink.enterId': 'AESOP ID خود را وارد کنید',
    'magicLink.rememberId': 'AESOP ID مرا به خاطر بسپار',
    'magicLink.submit': 'لینک جادویی برایم بفرستید',
    'magicLink.invalidId': 'لطفاً یک AESOP ID معتبر وارد کنید.',
    'magicLink.sending': 'در حال بررسی AESOP ID و ارسال لینک جادویی…',
    'magicLink.networkError': 'خطای داخلی. لطفاً دوباره تلاش کنید.',

    'profile.applicantBlockedTitle': 'برای متقاضیان در دسترس نیست',
    'profile.applicantBlockedPrefix':
      'به‌روزرسانی شماره Ding فقط برای محصلین و معلمان ثبت‌نام‌شده است. برای دیدن اطلاعات درخواست به',
    'profile.applicantBlockedSuffix': 'برگردید.',
    'profile.sessionIncompleteTitle': 'نشست ناقص است',
    'profile.sessionIncompletePrefix': 'به',
    'profile.sessionIncompleteSuffix': 'برگردید و با AESOP ID خود وصل شوید تا حساب شما بارگذاری شود.',
    'profile.backToProfile': 'پروفایل',

    'intent.signInProfileTitle': 'برای مدیریت شماره Ding وارد شوید',
    'intent.signInGenericTitle': 'برای کمک مخصوص حساب خود وارد شوید',
    'intent.openedLink': 'شما لینکی مربوط به {{title}} باز کرده‌اید.',
    'intent.requestMagicLink': 'درخواست لینک جادویی',
    'intent.magicLinkHelpBeforeFaq': 'با AESOP ID خود — یک لینک یک‌بار مصرف ایمیل می‌کنیم. صفحه',
    'intent.magicLinkHelpAfterFaq': 'نیاز به ورود ندارد.',
    'intent.editDing': 'تغییر Ding',
    'intent.faq': 'سوالات متداول',

    'reviews.pageTitle': 'بررسی درخواست‌ها',
    'reviews.pageLead': 'انشا را بخوانید، سطح انگلیسی را تعیین کنید، و تناسب با برنامه را نمره دهید.',
    'reviews.loading': 'در حال بارگذاری درخواست‌ها…',
    'reviews.loadError': 'بارگذاری وظایف بررسی ممکن نشد.',
    'reviews.empty': 'هیچ درخواستی برای بررسی به شما اختصاص داده نشده است.',
    'reviews.accessDenied': 'برای دیدن این صفحه دسترسی بررسی‌کننده لازم است.',
    'reviews.applicantId': 'AESOP ID',
    'reviews.appliedLevel': 'سطح درخواستی',
    'reviews.notAvailable': 'ثبت نشده',
    'reviews.essayLabel': 'انشا',
    'reviews.essayMissing': 'انشا موجود نیست.',
    'reviews.playVoice': 'پخش یادداشت صوتی',
    'reviews.voiceComingSoon': 'به‌زودی',
    'reviews.levelLabel': 'سطح انگلیسی',
    'reviews.suspectedAi': 'مشکوک به هوش مصنوعی',
    'reviews.suspectedAiFlagged': 'مشکوک به هوش مصنوعی — علامت‌گذاری شد',
    'reviews.suspectedAiOffHint': 'اگر انشا احتمالاً با هوش مصنوعی نوشته شده علامت بزنید',
    'reviews.fitnessLabel': 'تناسب با برنامه',
    'reviews.fitness.instruction': 'دستورالعمل',
    'reviews.fitness.original': 'اصالت',
    'reviews.fitness.character': 'شخصیت',
    'reviews.rubric.moreInfo': 'راهنمای نمره‌دهی',
    'reviews.rubric.highestLabel': 'بالاترین',
    'reviews.rubric.adequateLabel': 'متوسط',
    'reviews.rubric.lowLabel': 'پایین',
    'reviews.rubric.instructionFollowing.title': 'پیروی از دستورالعمل',
    'reviews.rubric.instructionFollowing.highest':
      'دانش‌آموز دستورالعمل‌های پرسش‌ها را درست فهمیده و دنبال کرده است.',
    'reviews.rubric.instructionFollowing.adequate':
      'درک یا پیروی از دستورالعمل‌ها یا پرسش‌ها تا حدی ناقص است.',
    'reviews.rubric.instructionFollowing.low':
      'دانش‌آموز دستورالعمل‌ها را نفهمیده یا دنبال نکرده، یا درباره پرسش بحث نکرده است.',
    'reviews.rubric.originalThinking.title': 'تفکر مستقل / اصیل',
    'reviews.rubric.originalThinking.highest':
      'دانش‌آموز نشانه‌ای از تفکر اصیل دارد — فراتر از کلیشه یا حقایق ساده.',
    'reviews.rubric.originalThinking.adequate': 'دانش‌آموز تا حدی نشانه‌ای از تفکر اصیل دارد.',
    'reviews.rubric.originalThinking.low':
      'ایده‌های دانش‌آموز بسیار ساده یا کلیشه‌ای است. قبلاً زیاد دیده‌اید.',
    'reviews.rubric.character.title': 'نشان‌دادن شخصیت',
    'reviews.rubric.character.highest':
      'نشانه روشنی از شخصیت قوی وجود دارد که به جامعه می‌افزاید. این متقاضی را در AESOP می‌خواهید.',
    'reviews.rubric.character.adequate':
      'تا حدی نشانه شخصیت قوی وجود دارد. شاید به جامعه چیزی اضافه کند.',
    'reviews.rubric.character.low':
      'نشانه واقعی از شخصیت قوی نیست. حس نمی‌کنید این فرد به جامعه AESOP چیزی اضافه کند.',
    'reviews.scalePlaceholder': 'نمره را انتخاب کنید…',
    'reviews.scalePlaceholderFor': 'نمره {{field}} را انتخاب کنید',
    'reviews.scale.lowest': 'پایین‌ترین',
    'reviews.scale.midpoint': 'میانه',
    'reviews.scale.highest': 'بالاترین',
    'reviews.scoringAria': 'نمره‌دهی بررسی',
    'reviews.studentList': 'متقاضیان',
    'reviews.nextStudent': 'متقاضی بعدی',
    'reviews.savePending': 'به‌زودی ذخیره می‌شود…',
    'reviews.saveSaving': 'در حال ذخیره…',
    'reviews.saveSavedJustNow': 'همین الان ذخیره شد',
    'reviews.saveSavedSecondsAgo': '{{seconds}} ثانیه پیش ذخیره شد',
    'reviews.saveSavedMinutesAgo': '{{minutes}} دقیقه پیش ذخیره شد',
    'reviews.saveSavedMinutesAgoPlural': '{{minutes}} دقیقه پیش ذخیره شد',
    'reviews.saveStatusError': 'ذخیره نشد — دوباره تلاش می‌شود',
    'reviews.saveStatusSaving': 'در حال ذخیره…',
  },
};

/**
 * @returns {PortalLocale}
 */
function getStoredPortalLocale() {
  if (typeof localStorage === 'undefined') {
    return 'en';
  }
  const stored = String(localStorage.getItem(PORTAL_LOCALE_STORAGE_KEY) || '').trim().toLowerCase();
  return stored === 'fa' ? 'fa' : 'en';
}

/**
 * @param {PortalLocale} locale
 */
function setStoredPortalLocale(locale) {
  if (typeof localStorage === 'undefined') {
    return;
  }
  localStorage.setItem(PORTAL_LOCALE_STORAGE_KEY, locale === 'fa' ? 'fa' : 'en');
}

/**
 * @param {PortalLocale} locale
 * @param {string} key
 * @param {Record<string, string|number>|undefined} [params]
 * @returns {string}
 */
function translatePortalText(locale, key, params) {
  const table = TRANSLATIONS[locale] || TRANSLATIONS.en;
  const fallback = TRANSLATIONS.en[key] || key;
  let text = table[key] || fallback;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{{${name}}}`, String(value));
    }
  }
  return text;
}

/**
 * @param {PortalLocale} locale
 * @param {string} status
 * @returns {string}
 */
function translateApplicationStatusLabel(locale, status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'accepted') {
    return translatePortalText(locale, 'applicationStatus.accepted');
  }
  if (normalized === 'rejected') {
    return translatePortalText(locale, 'applicationStatus.rejected');
  }
  if (normalized === 'pending') {
    return translatePortalText(locale, 'applicationStatus.pending');
  }
  return String(status || '').trim();
}

/**
 * @param {PortalLocale} locale
 * @param {'valid'|'too_short'|'too_long'|'unknown'} status
 * @param {{ minSeconds?: number, maxSeconds?: number }} [limits]
 * @returns {string|null}
 */
function translateVoiceMemoDurationWarning(locale, status, limits = {}) {
  const minSeconds = limits.minSeconds ?? 30;
  const maxSeconds = limits.maxSeconds ?? 120;
  const maxMinutes = Math.floor(maxSeconds / 60);
  if (status === 'too_short') {
    return translatePortalText(locale, 'voiceMemo.tooShort', { minSeconds, maxMinutes });
  }
  if (status === 'too_long') {
    return translatePortalText(locale, 'voiceMemo.tooLong', { minSeconds, maxMinutes });
  }
  return null;
}

/**
 * @param {PortalLocale} locale
 */
function applyPortalDocumentLocale(locale) {
  if (typeof document === 'undefined') {
    return;
  }
  const isRtl = locale === 'fa';
  document.documentElement.lang = isRtl ? 'fa-AF' : 'en';
  document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
  document.body.dir = isRtl ? 'rtl' : 'ltr';
  document.body.classList.toggle('portal-locale-fa', isRtl);
  document.body.classList.toggle('portal-locale-en', !isRtl);
}

module.exports = {
  getStoredPortalLocale,
  setStoredPortalLocale,
  translatePortalText,
  translateApplicationStatusLabel,
  translateVoiceMemoDurationWarning,
  applyPortalDocumentLocale,
};
