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
    'nav.stats': 'Stats',
    'nav.reviewApplications': 'Review Applications',
    'nav.portalNav': 'Portal navigation',

    'header.studentPortal': 'AESOP Portal',
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
    'header.homeAria': 'AESOP Afghanistan AESOP Portal — home',

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
      'This secure applicant portal is where you sign in with a login link—there is no password to remember on this site. Check your application status, Round 2 voice memo, and the application calendar here, and read',
    'hub.aboutStudentPrefix':
      'This secure student portal is where you sign in with a login link—there is no password to remember on this site. Use it to update your Afghanistan Ding phone number when it changes (with confirmation), review past Ding updates, request help if you need a non-Afghan number for Ding, and read',
    'hub.aboutStudentSuffix':
      'Your AESOP ID, email, and Ding number above summarize what we have on file—open',
    'hub.aboutStudentEnd': 'to change your Ding number.',
    'hub.aboutGuestLine1':
      'The AESOP Student Portal helps you update your Afghanistan Ding number, see Ding number history after you sign in, and read FAQs—using a login link, not a password on this site.',
    'hub.aboutGuestSectionsLead': 'Portal sections:',
    'hub.aboutGuestAnd': 'and',
    'hub.aboutGuestNotConnected': 'Not connected?',
    'hub.aboutGuestRequestAbove': 'above with your AESOP ID.',
    'hub.preferMainSite': 'Prefer the main site?',
    'hub.profileIntro':
      'Sign in with your login link to update your Afghanistan Ding number, view history, or request help with a non-Afghan number.',
    'hub.faqLink': 'frequently asked questions',
    'hub.studentPortalTitle': 'AESOP Portal',
    'hub.comingSoonTitle': 'Welcome, {{name}}!',
    'hub.comingSoonTitleNoName': 'Welcome!',
    'hub.comingSoonMessage': 'Your profile page is coming soon.',
    'hub.comingSoonMessage2':
      'The developers here at AESOP are working hard on the portal, and we are prioritizing new student applications for the next week or so. Watch this space!',
    'hub.comingSoonSignoff': 'Your friendly developers,',
    'hub.comingSoonSignoffNames': 'Teo and Farahnosh',
    'hub.reviewerLead':
      'Open Review Applications to score essays for applicants assigned to you.',
    'hub.signInHeading': 'Log in with your AESOP ID',
    'hub.signInLead':
      'Enter the ID that AESOP provided you. We will email you a login link that will log you in to the AESOP Portal.',
    'hub.signInIdHint':
      'Your student ID should be either 10 or 11 numbers and looks like: 2617391637',
    'hub.readFaqs': 'Read FAQs',

    'applicationStatus.accepted': 'Accepted to Round 2 Selection',
    'applicationStatus.rejected': 'Not selected to advance',
    'applicationStatus.pending': 'Pending',

    'role.applicant': 'Applicant',
    'role.student': 'Student',
    'role.teacher': 'Teacher',
    'role.admin': 'Admin',

    'voiceMemo.checking': 'Checking voice memo status…',
    'voiceMemo.submitted': 'Submitted',
    'voiceMemo.submittedWithIssues': 'Submitted with issues',
    'voiceMemo.notSubmitted': 'Not submitted yet',
    'voiceMemo.noneTitle': 'No voice note submitted',
    'voiceMemo.noneLead':
      'You still need to submit your Round 2 voice note. Please do this as soon as possible using the instructions you received by email, or the instructions below.',
    'voiceMemo.whyTitle': 'Why haven\'t you received my voice note?',
    'voiceMemo.why1Before': 'You have not sent a message to',
    'voiceMemo.why1After': ' on Signal.',
    'voiceMemo.why2': 'It has been less than three days since you sent your messages.',
    'voiceMemo.why3': 'You submitted a voice note but did not send your AESOP ID.',
    'voiceMemo.why4':
      'You sent a message on Signal with your AESOP ID but did not send a voice note.',
    'voiceMemo.whyTitle2': 'Good to know:',
    'voiceMemo.goodToKnow1':
      'Please submit **ONE** voice note for your application. We will review the most recent and longest voice note you send.',
    'voiceMemo.goodToKnow2':
      'Voice notes must be at least **30 seconds** long. Submissions shorter than **30 seconds** will be rejected automatically.',
    'voiceMemo.goodToKnow3':
      'If you send a new voice note later, your submission will be updated within **3 days**.',
    'voiceMemo.reviewRequest1':
      'If you believe you have followed all the steps above, please send a message on Signal to',
    'voiceMemo.reviewRequest2': 'saying "Please review my voice note" **in English**.',
    'voiceMemo.durationWithin': 'This is within the required range of 30 seconds to 2 minutes.',
    'voiceMemo.durationExceeding': 'You\'re exceeding expectations!',
    'voiceMemo.resubmitButton': 'Resubmit on Signal',
    'voiceMemo.instrTitle': 'How to submit your Round 2 voice note',
    'voiceMemo.promptTitle': 'Round 2 Prompt',
    'voiceMemo.promptLead':
      'Your voice note should answer this prompt in your own best English.',
    'voiceMemo.instrDeadline':
      'Complete every step by 11:59 pm Afghanistan time on Thursday, July 16, 2026.',
    'voiceMemo.instrStep1Title': 'Create a Signal account',
    'voiceMemo.instrStep1Body': 'Download the Signal app from',
    'voiceMemo.instrStep1Help': 'New to Signal? Watch how to set up an account:',
    'voiceMemo.instrVideo1': 'Video 1',
    'voiceMemo.instrVideo2': 'Video 2',
    'voiceMemo.instrStep2Title': 'Send two messages to noreplyaesop.55 on Signal',
    'voiceMemo.instrStep2Open': 'Open this link to start the chat:',
    'voiceMemo.instrStep2Link': 'Message noreplyaesop.55',
    'voiceMemo.instrStep2Intro': 'Then send these two messages:',
    'voiceMemo.instrStep2Id': 'Your AESOP ID number:',
    'voiceMemo.instrStep2Voice':
      'A voice note in your own best English answering the Round 2 Prompt above. It must be between 30 seconds and 2 minutes. Do NOT use ChatGPT or grammar checkers. Anything under 30 seconds is too short and will be rejected.',
    'voiceMemo.instrStep3Title': 'Check your status here',
    'voiceMemo.instrStep3Body':
      'This page updates automatically — you will not get a reply on Signal, and all updates come by email. A new voice note can take up to 3 days to appear here.',
    'voiceMemo.doneTitle': 'You\'re all set!',
    'voiceMemo.doneLead':
      'We\'ve received your Round 2 voice note, so there\'s nothing more you need to do right now. We will email you with your result.',
    'voiceMemo.resubmitSummary': 'Click here to learn how',
    'voiceMemo.pendingNote':
      'Your voice note can take up to 3 days to appear on the AESOP Portal after you send it.',
    'voiceMemo.label': 'Voice memo',
    'voiceMemo.submittedOn': 'Submitted on',
    'voiceMemo.recordingLength': 'Recording length',
    'voiceMemo.audioUnavailable':
      'Your submission is recorded, but the audio file is not available to play yet. Please check again later.',
    'voiceMemo.audioPlayError':
      'Could not play your voice memo. Refresh the stream and try again.',
    'voiceMemo.streamExpired':
      'This playback link has expired. Refresh the stream to continue.',
    'voiceMemo.refreshStream': 'Refresh stream',
    'voiceMemo.refreshingStream': 'Refreshing…',
    'voiceMemo.audioTryAgainLater': 'Please try again later.',
    'voiceMemo.instructionsParagraph':
      'Submit your Round 2 voice memo using the instructions you received by email. Once it is received, this page will show Submitted and you can listen to your recording here. Your voice note can take up to 3 days to appear on the AESOP Portal after you send it. You may submit your voice notes as many times as you\'d like, but only ONE voice notes will be saved.',
    'voiceMemo.loadError': 'Could not load voice memo status.',
    'voiceMemo.networkError': 'Network error. Please try again.',
    'voiceMemo.sectionAria': 'Round 2 voice memo',
    'voiceMemo.accordionAria': 'Voice memo',
    'voiceMemo.audioUnsupported': 'Your browser does not support audio playback.',
    'voiceMemo.tooShort':
      'Your voice memo is shorter than {{minSeconds}} seconds. Please record again and resubmit a memo between {{minSeconds}} seconds and {{maxMinutes}} minutes. Applications with voice memos shorter than {{minSeconds}} seconds will be rejected automatically.',
    'voiceMemo.tooLong':
      'Your voice memo is longer than {{maxMinutes}} minutes. Please record again and resubmit a memo between {{minSeconds}} seconds and {{maxMinutes}} minutes.',

    'calendar.label': 'Calendar',
    'calendar.loading': 'Loading calendar…',
    'calendar.empty': 'No application dates are listed yet.',
    'calendar.process': 'Application process',
    'calendar.date': 'Date',
    'calendar.info': 'More info',
    'calendar.networkError': 'Network error. Please try again.',
    'calendar.loadError': 'Could not load calendar.',
    'calendar.sectionAria': 'Application calendar',
    'calendar.accordionAria': 'Calendar',
    'calendar.deadlineNote': 'All times are 11:59 PM Afghanistan Time.',
    'calendar.event.round2VoiceDeadline': 'Round 2 Voice Note Submission Deadline',
    'calendar.event.round2Results': 'Round 2 Results Shared by Email',
    'calendar.event.round3InterviewsBegin': 'Round 3 Interviews Begin',
    'calendar.event.round3InterviewsEnd': 'Round 3 Interviews End',
    'calendar.event.round3Decision': 'Final Round 3 Admission Decision Shared',
    'calendar.event.openingCeremony': 'Opening Ceremony',
    'calendar.event.classesStart': 'Classes Start',
    'calendar.event.classesEnd': 'Classes End',
    'calendar.note.round2Results':
      'You will receive an email with your Round 2 result with next steps for the application process.',
    'calendar.note.round3InterviewsBegin':
      'More information about Round 3 Interviews will be shared with an email if you are selected.',
    'calendar.note.round2VoiceResubmit':
      'You may resubmit voice notes up to 11:59 pm on the deadline. Note that it can take up to 3 days for your voice note to update on the Portal.',
    'calendar.note.round3Decision':
      'You will receive an email if you are accepted to the Fall 2026 AESOP Classes.',
    'calendar.note.voiceCompleted':
      'Thank you for successfully completing all the required steps. We will email you by Friday, July 24 with your result.',

    'magicLink.aesopId': 'AESOP ID',
    'magicLink.enterId': 'Enter your AESOP ID',
    'magicLink.rememberId': 'Remember my ID',
    'magicLink.submit': 'Email me a login link',
    'magicLink.invalidId': 'Please enter a valid ID.',
    'magicLink.invalidIdNotFound':
      'Your ID is invalid. Please enter a correct ID. Please enter the AESOP ID you received in your email.',
    'magicLink.linkSent':
      'If your AESOP ID is on file, check your email for a login link (including spam). It may take a minute to arrive.',
    'magicLink.sending': 'Checking your ID and sending a login link...',
    'magicLink.networkError': 'Internal error. Please try again.',
    'magicLink.alreadySentWait':
      'We already sent a login link to your email. Please check your inbox (and spam). You can request another in {{wait}}.',
    'magicLink.waitBeforeRetry': 'Please wait {{wait}} before requesting another login link.',
    'magicLink.rateLimited':
      'Too many login link requests for this AESOP ID. Each request counts even if you have not signed in yet. Please try again in {{wait}}.',
    'magicLink.waitAboutOneMinute': 'about 1 minute',
    'magicLink.waitAboutMinutes': 'about {{minutes}} minutes',
    'magicLink.resendFailed': 'Unable to send a new login link. Enter your AESOP ID below.',
    'magicLink.resendOneClick': 'Email me a new login link',

    'verify.verifying': 'Verifying login link...',
    'verify.success': 'Login link verified successfully. Redirecting...',
    'verify.checkEmail': 'Check your email',
    'verify.failed': 'Verification Failed',
    'verify.invalidLink': 'Invalid Link',
    'verify.noToken': 'No token provided. Please check your email link.',
    'verify.invalidToken': 'Invalid token format.',
    'verify.expiredCanResend':
      'This login link has expired. Click below and we will email a fresh link to your registered address.',
    'verify.usedCanResend':
      'This login link was already used. Click below and we will email a fresh link to your registered address.',
    'verify.failedCanResend':
      'This login link is no longer valid. Click below and we will email a fresh link to your registered address.',
    'verify.failedEnterId':
      'This login link is no longer valid. Enter your AESOP ID below to request a new one.',
    'verify.networkError':
      'Could not reach the server to verify your link. Check your connection and try again.',
    'verify.sessionError':
      'Sign-in succeeded but this browser could not save your session. Try the link again or use a regular (non-private) browser window.',

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
    'intent.requestMagicLink': 'Request a login link',
    'intent.magicLinkHelpBeforeFaq': 'with your AESOP ID—we\'ll email you a one-time link. The',
    'intent.magicLinkHelpAfterFaq': 'page does not require signing in.',
    'intent.editDing': 'Edit Ding',
    'intent.faq': 'FAQs',

    'reviews.pageTitle': 'Review Applications',
    'reviews.pageLead': 'Review essays, set English level, and score fitness for the program.',
    'reviews.loading': 'Loading applications…',
    'reviews.loadError': 'Could not load review assignments.',
    'reviews.loadTimeout': 'Loading review assignments timed out. Please try again.',
    'reviews.empty': 'No applications are assigned to you for review.',
    'reviews.accessDenied':
      'Reviewer access is required to view this page. Your AESOP ID must be marked as a reviewer on the People sheet (Reviewer column), then sign out and use a new login link.',
    'reviews.applicantId': 'AESOP ID',
    'reviews.age': 'Age',
    'reviews.appliedLevel': 'Applied level',
    'reviews.notAvailable': 'Not listed',
    'reviews.essayLabel': 'Essay',
    'reviews.essayMissing': 'No essay on file.',
    'reviews.playVoice': 'Play voice note',
    'reviews.downloadMp4': 'Download MP4',
    'reviews.durationExceeding': 'They exceeded expectations!',
    'reviews.refreshStream': 'Refresh stream',
    'reviews.refreshingStream': 'Refreshing…',
    'reviews.voiceComingSoon': 'Coming soon',
    'reviews.voiceNotAvailable': 'No voice note on file',
    'reviews.voiceAudioUnsupported': 'Your browser does not support audio playback.',
    'reviews.streamExpired':
      'This playback link has expired. Refresh the stream to continue.',
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
    'nav.stats': 'آمار',
    'nav.reviewApplications': 'بررسی درخواست‌ها',
    'nav.portalNav': 'مسیریابی پورتال',

    'header.studentPortal': 'پورتال AESOP',
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
    'header.homeAria': 'پورتال AESOP افغانستان AESOP — صفحه اصلی',

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
      'این پورتال امن متقاضیان است که با لینک ورود وارد می‌شوید — در این سایت رمز عبور وجود ندارد. وضعیت درخواست، یادداشت صوتی دور دوم و تقویم درخواست را اینجا ببینید و',
    'hub.aboutStudentPrefix':
      'این پورتال امن محصلین است که با لینک ورود وارد می‌شوید — در این سایت رمز عبور وجود ندارد. شماره Ding افغانستان خود را به‌روز کنید، سابقه تغییرات را ببینید، در صورت نیاز به شماره غیرافغانی درخواست کمک کنید و',
    'hub.aboutStudentSuffix':
      'AESOP ID، ایمیل و شماره Ding بالا خلاصه اطلاعات ثبت‌شده است — برای تغییر شماره Ding به',
    'hub.aboutStudentEnd': 'بروید.',
    'hub.aboutGuestLine1':
      'پورتال محصلین AESOP به شما کمک می‌کند شماره Ding افغانستان خود را به‌روز کنید، پس از ورود سابقه تغییرات را ببینید و سوالات متداول را بخوانید — با لینک ورود، نه رمز عبور در این سایت.',
    'hub.aboutGuestSectionsLead': 'بخش‌های پورتال:',
    'hub.aboutGuestAnd': 'و',
    'hub.aboutGuestNotConnected': 'وصل نیستید؟',
    'hub.aboutGuestRequestAbove': 'بالا با AESOP ID خود درخواست دهید.',
    'hub.preferMainSite': 'ترجیح می‌دهید سایت اصلی را ببینید؟',
    'hub.profileIntro':
      'با لینک ورود وارد شوید تا شماره Ding افغانستان خود را به‌روز کنید، سابقه را ببینید یا در مورد شماره غیرافغانی درخواست کمک کنید.',
    'hub.faqLink': 'سوالات متداول',
    'hub.studentPortalTitle': 'پورتال AESOP',
    'hub.comingSoonTitle': 'خوش آمدید، {{name}}!',
    'hub.comingSoonTitleNoName': 'خوش آمدید!',
    'hub.comingSoonMessage': 'صفحه پروفایل شما به‌زودی آماده می‌شود.',
    'hub.comingSoonMessage2':
      'توسعه‌دهندگان AESOP سخت روی پورتال کار می‌کنند و در یک هفته آینده اولویت را به درخواست‌های جدید محصلان می‌دهیم. منتظر باشید!',
    'hub.comingSoonSignoff': 'توسعه‌دهندگان دوست شما،',
    'hub.comingSoonSignoffNames': 'Teo و Farahnosh',
    'hub.reviewerLead':
      'برای نمره‌دهی به مقاله‌های متقاضیانِ اختصاص‌داده‌شده به شما، «بررسی درخواست‌ها» را باز کنید.',
    'hub.signInHeading': 'با AESOP ID خود وارد شوید',
    'hub.signInLead':
      'شناسه‌ای که AESOP به شما داده را وارد کنید. ما یک لینک ورود برای شما ایمیل می‌کنیم که شما را به پورتال AESOP وارد می‌کند.',
    'hub.signInIdHint':
      'شناسه محصلی شما باید ۱۰ یا ۱۱ رقم باشد و مانند این است: 2617391637',
    'hub.readFaqs': 'خواندن سوالات متداول',

    'applicationStatus.accepted': 'پذیرفته‌شده به مرحلهٔ انتخاب دور دوم',
    'applicationStatus.rejected': 'برای مرحلهٔ بعدی انتخاب نشد',
    'applicationStatus.pending': 'در انتظار',

    'role.applicant': 'متقاضی',
    'role.student': 'محصل',
    'role.teacher': 'معلم',
    'role.admin': 'مدیر',

    'voiceMemo.checking': 'در حال بررسی یادداشت صوتی…',
    'voiceMemo.submitted': 'ثبت شده',
    'voiceMemo.submittedWithIssues': 'ثبت شده با مشکل',
    'voiceMemo.notSubmitted': 'هنوز ثبت نشده',
    'voiceMemo.noneTitle': 'هیچ یادداشت صوتی ثبت نشده است',
    'voiceMemo.noneLead':
      'شما هنوز باید یادداشت صوتی دور دوم خود را ارسال کنید. لطفاً هرچه زودتر با استفاده از دستورالعمل‌هایی که از طریق ایمیل دریافت کرده‌اید، یا دستورالعمل‌های زیر، این کار را انجام دهید.',
    'voiceMemo.whyTitle': 'چرا یادداشت صوتی مرا دریافت نکرده‌اید؟',
    'voiceMemo.why1Before': 'در Signal پیامی به',
    'voiceMemo.why1After': ' نفرستاده‌اید.',
    'voiceMemo.why2': 'از زمان ارسال پیام‌های شما کمتر از سه روز گذشته است.',
    'voiceMemo.why3': 'یادداشت صوتی فرستاده‌اید اما شمارهٔ شناسایی ایساپ خود را نفرستاده‌اید.',
    'voiceMemo.why4':
      'در Signal پیامی با شمارهٔ شناسایی ایساپ خود فرستاده‌اید اما یادداشت صوتی نفرستاده‌اید.',
    'voiceMemo.whyTitle2': 'خوب است بدانید:',
    'voiceMemo.goodToKnow1':
      'لطفاً **یک** یادداشت صوتی برای درخواست خود ارسال کنید. ما جدیدترین و طولانی‌ترین یادداشت صوتی را که می‌فرستید بررسی می‌کنیم.',
    'voiceMemo.goodToKnow2':
      'یادداشت‌های صوتی باید حداقل **۳۰ ثانیه** باشند. ارسال‌های کوتاه‌تر از **۳۰ ثانیه** به‌صورت خودکار رد می‌شوند.',
    'voiceMemo.goodToKnow3':
      'اگر بعداً یادداشت صوتی جدیدی بفرستید، ارسال شما ظرف **۳ روز** به‌روزرسانی می‌شود.',
    'voiceMemo.reviewRequest1':
      'اگر فکر می‌کنید همهٔ مراحل بالا را انجام داده‌اید، لطفاً در Signal پیامی به',
    'voiceMemo.reviewRequest2':
      'بفرستید و در آن **به انگلیسی** بنویسید: «Please review my voice note»',
    'voiceMemo.durationWithin': 'این مدت در محدودهٔ لازم، یعنی بین ۳۰ ثانیه تا ۲ دقیقه است.',
    'voiceMemo.durationExceeding': 'شما فراتر از انتظار عمل کردید!',
    'voiceMemo.resubmitButton': 'ارسال دوباره در Signal',
    'voiceMemo.instrTitle': 'چگونه یادداشت صوتی مرحلهٔ دوم خود را ارسال کنید',
    'voiceMemo.promptTitle': 'سؤال مرحلهٔ دوم',
    'voiceMemo.promptLead':
      'یادداشت صوتی شما باید به این سؤال در بهترین زبان انگلیسی خودتان پاسخ دهد.',
    'voiceMemo.instrDeadline':
      'تمام مراحل را تا ساعت ۱۱:۵۹ شب به وقت افغانستان، روز پنجشنبه ۱۶ جولای ۲۰۲۶ تکمیل کنید.',
    'voiceMemo.instrStep1Title': 'یک حساب Signal بسازید',
    'voiceMemo.instrStep1Body': 'اپلیکیشن Signal را از این آدرس دانلود کنید:',
    'voiceMemo.instrStep1Help': 'با Signal آشنا نیستید؟ طرز ساختن حساب را ببینید:',
    'voiceMemo.instrVideo1': 'ویدیوی ۱',
    'voiceMemo.instrVideo2': 'ویدیوی ۲',
    'voiceMemo.instrStep2Title': 'در Signal دو پیام به noreplyaesop.55 بفرستید',
    'voiceMemo.instrStep2Open': 'برای شروع گفتگو این لینک را باز کنید:',
    'voiceMemo.instrStep2Link': 'پیام به noreplyaesop.55',
    'voiceMemo.instrStep2Intro': 'سپس این دو پیام را بفرستید:',
    'voiceMemo.instrStep2Id': 'شمارهٔ شناسایی ایساپ شما:',
    'voiceMemo.instrStep2Voice':
      'یک پیام صوتی به بهترین زبان انگلیسی خودتان در پاسخ به سؤال مرحلهٔ دوم در بالا. باید بین ۳۰ ثانیه تا ۲ دقیقه باشد. از ChatGPT یا برنامه‌های تصحیح گرامر استفاده نکنید. هر پیام کوتاه‌تر از ۳۰ ثانیه بسیار کوتاه است و رد خواهد شد.',
    'voiceMemo.instrStep3Title': 'وضعیت خود را همین‌جا بررسی کنید',
    'voiceMemo.instrStep3Body':
      'این صفحه به‌طور خودکار به‌روزرسانی می‌شود؛ در Signal پاسخی دریافت نخواهید کرد و همهٔ به‌روزرسانی‌ها از طریق ایمیل ارسال می‌شود. ممکن است تا ۳ روز طول بکشد تا یادداشت صوتی جدید این‌جا نمایش داده شود.',
    'voiceMemo.doneTitle': 'کارتان تمام شد!',
    'voiceMemo.doneLead':
      'ما یادداشت صوتی مرحلهٔ دوم شما را دریافت کردیم، پس در حال حاضر کار دیگری لازم نیست انجام دهید. نتیجه را از طریق ایمیل برایتان خواهیم فرستاد.',
    'voiceMemo.resubmitSummary': 'برای یادگیری نحوهٔ کار اینجا کلیک کنید',
    'voiceMemo.pendingNote':
      'یادداشت صوتی شما ممکن است تا ۳ روز پس از ارسال در پورتال دانش‌آموز نمایان شود.',
    'voiceMemo.label': 'یادداشت صوتی',
    'voiceMemo.submittedOn': 'ثبت شده در',
    'voiceMemo.recordingLength': 'مدت ضبط',
    'voiceMemo.audioUnavailable':
      'ارسال شما ثبت شده، اما فایل صوتی هنوز برای پخش در دسترس نیست. لطفاً بعداً دوباره بررسی کنید.',
    'voiceMemo.audioPlayError':
      'پخش یادداشت صوتی ممکن نشد. جریان را تازه کنید و دوباره تلاش کنید.',
    'voiceMemo.streamExpired':
      'این پیوند پخش منقضی شده است. برای ادامه، جریان را تازه کنید.',
    'voiceMemo.refreshStream': 'تازه کردن جریان',
    'voiceMemo.refreshingStream': 'در حال تازه‌سازی…',
    'voiceMemo.audioTryAgainLater': 'لطفاً بعداً دوباره تلاش کنید.',
    'voiceMemo.instructionsParagraph':
      'یادداشت صوتی دور دوم را طبق دستورالعمل ایمیل‌شده ارسال کنید. پس از دریافت، این صفحه «ثبت شده» را نشان می‌دهد و می‌توانید ضبط خود را بشنوید. یادداشت صوتی شما ممکن است تا ۳ روز پس از ارسال در پورتال AESOP نمایان شود. می‌توانید هر چند بار که بخواهید یادداشت صوتی بفرستید، اما فقط یک یادداشت صوتی ذخیره می‌شود.',
    'voiceMemo.loadError': 'بارگذاری وضعیت یادداشت صوتی ممکن نشد.',
    'voiceMemo.networkError': 'خطای شبکه. لطفاً دوباره تلاش کنید.',
    'voiceMemo.sectionAria': 'یادداشت صوتی دور دوم',
    'voiceMemo.accordionAria': 'یادداشت صوتی',
    'voiceMemo.audioUnsupported': 'مرورگر شما از پخش صدا پشتیبانی نمی‌کند.',
    'voiceMemo.tooShort':
      'یادداشت صوتی شما کوتاه‌تر از {{minSeconds}} ثانیه است. لطفاً دوباره ضبط کنید و یادداشتی بین {{minSeconds}} ثانیه تا {{maxMinutes}} دقیقه بفرستید. درخواست‌هایی با یادداشت صوتی کوتاه‌تر از {{minSeconds}} ثانیه به‌صورت خودکار رد می‌شوند.',
    'voiceMemo.tooLong':
      'یادداشت صوتی شما بیش از {{maxMinutes}} دقیقه است. لطفاً دوباره ضبط کنید و یادداشتی بین {{minSeconds}} ثانیه تا {{maxMinutes}} دقیقه بفرستید.',

    'calendar.label': 'تقویم',
    'calendar.loading': 'در حال بارگذاری تقویم…',
    'calendar.empty': 'هنوز تاریخ درخواست ثبت نشده است.',
    'calendar.process': 'مراحل درخواست',
    'calendar.date': 'تاریخ',
    'calendar.info': 'معلومات بیشتر',
    'calendar.networkError': 'خطای شبکه. لطفاً دوباره تلاش کنید.',
    'calendar.loadError': 'بارگذاری تقویم ممکن نشد.',
    'calendar.sectionAria': 'تقویم درخواست',
    'calendar.accordionAria': 'تقویم',
    'calendar.deadlineNote': 'همه ساعت‌ها ۱۱:۵۹ شب به وقت افغانستان است.',
    'calendar.event.round2VoiceDeadline': 'مهلت ارسال پیام صوتی دور دوم',
    'calendar.event.round2Results': 'نتایج دور دوم از طریق ایمیل اعلام می‌شود',
    'calendar.event.round3InterviewsBegin': 'آغاز مصاحبه‌های دور سوم',
    'calendar.event.round3InterviewsEnd': 'پایان مصاحبه‌های دور سوم',
    'calendar.event.round3Decision': 'اعلام تصمیم نهایی پذیرش دور سوم',
    'calendar.event.openingCeremony': 'مراسم افتتاح',
    'calendar.event.classesStart': 'شروع صنف‌ها',
    'calendar.event.classesEnd': 'پایان صنف‌ها',
    'calendar.note.round2Results':
      'نتیجهٔ دور دوم خود را همراه با مراحل بعدی درخواست از طریق ایمیل دریافت خواهید کرد.',
    'calendar.note.round3InterviewsBegin':
      'اگر انتخاب شوید، معلومات بیشتر دربارهٔ مصاحبه‌های دور سوم از طریق ایمیل با شما در میان گذاشته می‌شود.',
    'calendar.note.round2VoiceResubmit':
      'می‌توانید تا ساعت ۱۱:۵۹ شب در روز مهلت، پیام صوتی خود را دوباره ارسال کنید. توجه داشته باشید که ممکن است تا ۳ روز طول بکشد تا پیام صوتی شما در پورتال به‌روزرسانی شود.',
    'calendar.note.round3Decision':
      'اگر به صنف‌های خزان ۲۰۲۶ AESOP پذیرفته شوید، یک ایمیل دریافت خواهید کرد.',
    'calendar.note.voiceCompleted':
      'از اینکه همه مراحل لازم را با موفقیت تکمیل کردید سپاسگزاریم. تا جمعه، ۲۴ جولای نتیجهٔ شما را از طریق ایمیل به شما اطلاع می‌دهیم.',

    'magicLink.aesopId': 'AESOP ID',
    'magicLink.enterId': 'AESOP ID خود را وارد کنید',
    'magicLink.rememberId': 'AESOP ID مرا به خاطر بسپار',
    'magicLink.submit': 'لینک ورود برایم بفرستید',
    'magicLink.invalidId': 'لطفاً یک AESOP ID معتبر وارد کنید.',
    'magicLink.invalidIdNotFound':
      'AESOP ID شما معتبر نیست. لطفاً AESOP ID درست را وارد کنید — همان شناسه‌ای که در ایمیل خود دریافت کرده‌اید.',
    'magicLink.linkSent':
      'اگر AESOP ID شما در پرونده باشد، ایمیل خود را برای لینک ورود بررسی کنید (از جمله هرزنامه). ممکن است یک دقیقه طول بکشد.',
    'magicLink.sending': 'در حال بررسی AESOP ID و ارسال لینک ورود…',
    'magicLink.networkError': 'خطای داخلی. لطفاً دوباره تلاش کنید.',
    'magicLink.alreadySentWait':
      'ما قبلاً یک لینک ورود به ایمیل شما فرستاده‌ایم. لطفاً صندوق ورودی (و هرزنامه) را بررسی کنید. می‌توانید پس از {{wait}} دوباره درخواست دهید.',
    'magicLink.waitBeforeRetry': 'لطفاً {{wait}} صبر کنید و سپس دوباره لینک ورود بخواهید.',
    'magicLink.rateLimited':
      'درخواست‌های زیاد برای لینک ورود با این AESOP ID. هر درخواست شمرده می‌شود حتی اگر هنوز وارد نشده باشید. لطفاً پس از {{wait}} دوباره تلاش کنید.',
    'magicLink.waitAboutOneMinute': 'حدود ۱ دقیقه',
    'magicLink.waitAboutMinutes': 'حدود {{minutes}} دقیقه',
    'magicLink.resendFailed': 'ارسال لینک ورود جدید ممکن نشد. AESOP ID خود را در زیر وارد کنید.',
    'magicLink.resendOneClick': 'لینک ورود جدید برایم بفرستید',

    'verify.verifying': 'در حال تأیید لینک ورود…',
    'verify.success': 'لینک ورود با موفقیت تأیید شد. در حال انتقال…',
    'verify.checkEmail': 'ایمیل خود را بررسی کنید',
    'verify.failed': 'تأیید ناموفق بود',
    'verify.invalidLink': 'لینک نامعتبر',
    'verify.noToken': 'توکن ارائه نشده است. لطفاً لینک ایمیل خود را بررسی کنید.',
    'verify.invalidToken': 'فرمت توکن نامعتبر است.',
    'verify.expiredCanResend':
      'این لینک ورود منقضی شده است. روی دکمه زیر بزنید تا لینک تازه به ایمیل ثبت‌شده‌تان ارسال شود.',
    'verify.usedCanResend':
      'این لینک ورود قبلاً استفاده شده است. روی دکمه زیر بزنید تا لینک تازه به ایمیل ثبت‌شده‌تان ارسال شود.',
    'verify.failedCanResend':
      'این لینک ورود دیگر معتبر نیست. روی دکمه زیر بزنید تا لینک تازه به ایمیل ثبت‌شده‌تان ارسال شود.',
    'verify.failedEnterId':
      'این لینک ورود دیگر معتبر نیست. AESOP ID خود را در زیر وارد کنید تا لینک جدید بخواهید.',
    'verify.networkError':
      'اتصال به سرور برای تأیید لینک برقرار نشد. اتصال اینترنت خود را بررسی کنید و دوباره تلاش کنید.',
    'verify.sessionError':
      'ورود موفق بود اما این مرورگر نتوانست نشست شما را ذخیره کند. دوباره لینک را امتحان کنید یا از پنجره مرورگر عادی (غیرخصوصی) استفاده کنید.',

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
    'intent.requestMagicLink': 'درخواست لینک ورود',
    'intent.magicLinkHelpBeforeFaq': 'با AESOP ID خود — یک لینک یک‌بار مصرف ایمیل می‌کنیم. صفحه',
    'intent.magicLinkHelpAfterFaq': 'نیاز به ورود ندارد.',
    'intent.editDing': 'تغییر Ding',
    'intent.faq': 'سوالات متداول',

    'reviews.pageTitle': 'بررسی درخواست‌ها',
    'reviews.pageLead': 'انشا را بخوانید، سطح انگلیسی را تعیین کنید، و تناسب با برنامه را نمره دهید.',
    'reviews.loading': 'در حال بارگذاری درخواست‌ها…',
    'reviews.loadError': 'بارگذاری وظایف بررسی ممکن نشد.',
    'reviews.loadTimeout': 'بارگذاری وظایف بررسی بیش از حد طول کشید. لطفاً دوباره تلاش کنید.',
    'reviews.empty': 'هیچ درخواستی برای بررسی به شما اختصاص داده نشده است.',
    'reviews.accessDenied':
      'برای دیدن این صفحه دسترسی بررسی‌کننده لازم است. AESOP ID شما باید در برگه People در ستون Reviewer علامت‌گذاری شود، سپس خارج شوید و با لینک ورود جدید وارد شوید.',
    'reviews.applicantId': 'AESOP ID',
    'reviews.age': 'سن',
    'reviews.appliedLevel': 'سطح درخواستی',
    'reviews.notAvailable': 'ثبت نشده',
    'reviews.essayLabel': 'انشا',
    'reviews.essayMissing': 'انشا موجود نیست.',
    'reviews.playVoice': 'پخش یادداشت صوتی',
    'reviews.downloadMp4': 'دانلود MP4',
    'reviews.durationExceeding': 'آنها فراتر از انتظار عمل کردند!',
    'reviews.refreshStream': 'تازه کردن جریان',
    'reviews.refreshingStream': 'در حال تازه‌سازی…',
    'reviews.voiceComingSoon': 'به‌زودی',
    'reviews.voiceNotAvailable': 'یادداشت صوتی موجود نیست',
    'reviews.voiceAudioUnsupported': 'مرورگر شما از پخش صدا پشتیبانی نمی‌کند.',
    'reviews.streamExpired':
      'این پیوند پخش منقضی شده است. برای ادامه، جریان را تازه کنید.',
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
