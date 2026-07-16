/** Full reviewer training / rubric instructions (2026–2027 cycle). */

/** @typedef {{ ideas?: string, sentences?: string, vocabulary?: string, usage?: string[] }} EnglishLevelDetail */

const ENGLISH_LEVEL_RUBRIC_SECTION_SPLIT =
  /\.\s+(?=(?:Sentences|Vocabulary|Usage|جملات|واژگان|کاربرد):)/;

const ENGLISH_LEVEL_RUBRIC_LINE =
  /^(Ideas|Sentences|Vocabulary|Usage|ایده‌ها|جملات|واژگان|کاربرد):\s*(.+?)\.?$/s;

/**
 * @param {string} text
 * @returns {Array<{ label: string, text: string }> | null}
 */
function parseEnglishLevelRubricText(text) {
  const trimmed = String(text ?? '').trim();
  if (!/^(Ideas|ایده‌ها):/i.test(trimmed)) {
    return null;
  }

  const lines = trimmed
    .split(ENGLISH_LEVEL_RUBRIC_SECTION_SPLIT)
    .map((part) => {
      const match = part.match(ENGLISH_LEVEL_RUBRIC_LINE);
      if (!match) {
        return null;
      }
      return { label: match[1], text: match[2].trim() };
    })
    .filter(Boolean);

  return lines.length >= 2 ? lines : null;
}

/**
 * @param {EnglishLevelDetail} detail
 * @returns {Array<{ label: string, text: string }>}
 */
function englishLevelDetailToLines(detail) {
  /** @type {Array<{ label: string, text: string }>} */
  const lines = [];
  if (detail.ideas) {
    lines.push({ label: 'Ideas', text: detail.ideas });
  }
  if (detail.sentences) {
    lines.push({ label: 'Sentences', text: detail.sentences });
  }
  if (detail.vocabulary) {
    lines.push({ label: 'Vocabulary', text: detail.vocabulary });
  }
  if (detail.usage?.length) {
    lines.push({ label: 'Usage', text: detail.usage.join('; ') });
  }
  return lines;
}

/** @type {Array<{ score: string, summary?: string, detail?: EnglishLevelDetail }>} */
const ENGLISH_LEVEL_RUBRIC = [
  {
    score: '1',
    summary: 'No English. Essay is written in Dari.',
  },
  {
    score: '2',
    summary:
      'Very limited English. Essay is written in a combination of Dari and English or is extremely short, consisting of broken or very basic English sentences.',
  },
  {
    score: '3',
    detail: {
      ideas: 'Very simple',
      sentences: 'Short but readable.',
      vocabulary: 'Limited',
      usage: ['Plurals', 'Possessives', 'Subject verb agreement'],
    },
  },
  {
    score: '4',
    detail: {
      ideas: 'Simple',
      sentences: 'Longer, but not extremely complex',
      vocabulary: 'Limited',
      usage: [
        'Past, present progressive, and future verb tenses',
        'Can/could or other modal verbs, with some errors',
      ],
    },
  },
  {
    score: '5',
    detail: {
      ideas: 'Slightly more complex',
      sentences: 'Complex, but with errors',
      vocabulary: 'Developing',
      usage: ['Comparatives and superlatives', 'Adverbs'],
    },
  },
  {
    score: '6',
    detail: {
      ideas: 'More complex',
      sentences: 'Longer and more complex',
      vocabulary: 'Functional and flexible',
      usage: ['Perfect tenses, with few or no errors', 'Passive verbs, with few or no errors'],
    },
  },
  {
    score: '7',
    detail: {
      ideas: 'Sophisticated',
      sentences: 'Complex but sometimes formulaic',
      vocabulary: 'Functional and flexible',
      usage: ['Conditionals', 'Relative clauses'],
    },
  },
  {
    score: '8',
    detail: {
      ideas: 'Sophisticated',
      sentences: 'Complex and varied.',
      vocabulary: 'Wide and varied.',
      usage: ['Metaphors, similes, and idioms'],
    },
  },
  {
    score: '9',
    detail: {
      ideas: 'Sophisticated',
      sentences: 'Complex and varied',
      vocabulary: 'Exceptionally rich',
      usage: [
        'Full range of grammatical constructions, with few errors',
        'Colloquialisms',
      ],
    },
  },
  {
    score: '10',
    summary:
      'Approaching native-level fluency; very few noticeable errors. Could be mistaken for a native English speaker.',
  },
];

const AI_WARNING_SIGNS = [
  'Em-dashes (—)',
  'No errors of any kind',
  'Extremely sophisticated vocabulary, including figurative language (particularly if applying at a lower level)',
  'Many short paragraphs',
  '“It’s not just— it’s also…” / “not only, but also” constructions',
  'English described as a “bridge,” a “step towards,” “opening doors”',
];

const AI_ESSAY_EXAMPLES = [
  `In the future, I imagine myself as a confident and fluent English speaker who uses the language naturally in both personal and professional life. English will open many doors for me — helping me to connect with people from different cultures, access global information, and work in international environments. I see myself using English to study advanced courses, communicate with colleagues from around the world, and even travel with ease. I will continue improving my speaking, listening, reading, and writing skills through daily practice, online courses, and conversations with native speakers. Being an English speaker will not only strengthen my career opportunities but also build my self-confidence. I believe English is a bridge to global success and understanding, and in the coming years, I want to master it completely and use it as a powerful tool to achieve my dreams`,
  `I imagine my future as an English speaker to be full of confidence, connection, and new opportunities. As my fluency improves, I see myself communicating more naturally with people from different countries, whether in my professional career or in academic environments. I expect English to become a tool that helps me access global knowledge, collaborate on international projects, and express my ideas clearly without hesitation.In the future, I want to speak English with ease—understanding different accents, participating in discussions, and presenting my thoughts effectively. Being a strong English speaker will not only support my career goals but also give me the ability to travel, learn from diverse cultures, and broaden my perspective of the world. Overall, I imagine a future where English is a bridge that connects me to better opportunities and a more confident version of myself.`,
];

/** @type {Array<{ score: string, label: string, text: string }>} */
const TRAINING_ESSAY_EXAMPLES = [
  {
    score: '1',
    label: 'English Level 1',
    text: `من یک روز از دروازه بیرون شدم و به سوی کورس میرفتم و در پیش روی دروازه یک زن بود که بسیار خسته مانده نشسته بود و سودهای زیادی در دستش بود سوال کردم چی شده آن زن جوابم را داد گفت خیلی مانده شدم و توان ای سوداها را ندارم من هم دلم به حال او زن سوخت گفتم مشگل نداره من تا خانه تان مبرم بی آنگه فکر کنم کورس ام نا وقت شده یا دیگر به خانه آن زن رساندم و پس برگشتم تا کورس بروم خیلی نا وقت شده بود خیلی به عجله رفتم دیدم ده دقیقه گذشته و استاد در داخل صنف اجازه نداد با خودم گفتم مشگل نداره توانستم امروز یکی را خوشحال کنم و خلاصه خود را اینطور تعریف میکنم بسیار مهربان دلسوز هستم وبه مردم ناتوان کمک میکنم هر چند چیز مهم را از دست بدهم`,
  },
  {
    score: '2',
    label: 'English Level 2',
    text: `hi my iam Zahra and when i was 16 Iget married and  i have a baby even i am very interest English language and after learn English i will apply for a schol arship and complete my education
سلام مه سمیه استم 16 سالم بود  که ازدواج کردم یک طفل دارم از همو اول دوست داشتم انگلیسی را وقتی انگلیسی ره یادم گرفتم باز بخیر ده اسکالرشیپ بخاطر تکمیل تحصیلم اپلایی میکنم "`,
  },
  {
    score: '3',
    label: 'English Level 3',
    text: `my name is Talia and I am 15 year old I live in a small city in Badakhshan I have many friend in my school One day my classmate was very sad because she no understand math she always feel bad when teacher ask her question. I say her dont worry I help you I go to her home and we doing study together she is try hard and now she can do math very good I feel very happy because I help her she also is happy and now she help other students too I think help people is very good thing I want be a teacher in future and help more girls in my city for learn and become strong`,
  },
  {
    score: '4',
    label: 'English Level 4',
    text: `I'm Fatima an Afghan girl , who is simple and dreamy , like i want go abroad for counting my education but for this, I have to learn English and , we don't have allow to get out home to learn something, for this reason I want to learn online,
I think when receive my goals I not only I think but also I believe I can live like other women in the world, who can drive, can say no, can be taken out of the house alone.and full of positive energy.
And then I can help others girls to learn English language and skills.
When I was 4 grades in school, one day my teacher asked me to write something in English but I can not and she slapped me.and I ashamed it was just a simple thing for her but she destroyed my mood , andafter that I never give up and try to learn English .`,
  },
  {
    score: '5',
    label: 'English Level 5',
    text: `In the name of Allah.
My name is Maria.
When I was student at school I was teaching to my village childrens; now also I am teaching to these kind childrens. This is one of my big ambition that everyone must help and respect to children special who works in cities, streets, shops and at other places. When I was child I was also working in the streetand sold gums, kites and sometimes I was washing the car windows; when I remain my background I angry and sad. So I try to make place for education to this childrens in become have a good future. I don't charge from any students. I have 15 students they work part time in the street everyday. I sometimes buy pens, books and notebook to them. I will try in the future to make modern class with LCD and Computer this will be a convenient to students. Now I am teaching read and writing of Dari language and math subjects to all students. I trying to teaches them also English language  so I am truly deserve of this online English language course. 
Thanks a lot.`,
  },
  {
    score: '6',
    label: 'English Level 6',
    text: `Through my leadership skill ,I run a club of 10 girls working collaboratively to build  our capacities, accomplishing activities like painting pictures  ,displaying them in exhibition like TIKA to promote independence for myself and club members by selling pictures .Even though, I help them with academic studies too ,since they find studying online difficult due to financial problems. Their growth always fills me with pride for creating a safe space despite of education ban.Also ,i am currently teaching english language for the elementary level in my home for the project of JRS. I have always witnessed my people suffering from pain , financial problems even finding hard to pay tuition of their children classes and school or witnessing the bsn of classes and schools for girls always inspires me to serve and 
Help them by the step i have gotten .I have started teaching english volunteerly for my people childrens and girls to find the path of efucatiin more support.
One of my sweetest memory from my teaching was that I had a student named Nazanin who hated studying English and never tried to participate in class activities. But I helped her by dedicating extra time, leading and livening up her motivation  through, using innovative and fun methods of instruction .One day ,her mother came visited me to thank me by bringing gifts a scarf, perfume, and socks, which made me realize how a step of mine brought smiles and made her proud of herself and her family abd promote me to take more bigger steps and not stop to transfer this sensation of pride for individuals and every family .However ,I have student named fatima who is gifted at singing songs especially turkush song but she cannot display her talent for her family and society because of traditional belief they have.Her family thinks a girl mustn't be a singer in our family .Thus what i want to do for Afghan girls is to offer apportunities for indivuduals to find and display their talents with enough support of raising their voices and growth`,
  },
  {
    score: '7',
    label: 'English Level 7',
    text: `"At first I would like to say thank you for this opportunity for afghan girl.
I am an afghan girl who live in Kabul ,Afghanistan. I was studying economic at Kabul university but because of some circumstances I couldn't continue the study.

So I would like to talk about how to imagine your future as an English speaker?
Hundred percent I imagin my future brilliant. I have lost so many opportunities because of English. I am in intermediate level but for 4 years I have struggled with learning English and I have not able to go beyond the intermediate level. I want to share a little bit about my journey as a learner English: I started learning English in 2020. So i made so many plans for English and I did it everyday like: I studied English everyday like I studied for kankor even somedays I didn't gor to university I wanted to work on English and one day able to apply for scholarships, after English class I studied with my friend and in the way of home I talked to her, I was looking in social media for online friend to speak about a topic, I read English books and as far as I can I listened to English video. With all of those plan I haven't successed to talk fluency and apply for scholarships and other opportunities. Because of this I disappointed and give up since everytime I start something inside me tell me I can't finish or become fluent.
In 2023 I shortlisted for interview but after interview I rejected always. At that time again I wanted to improve but because of some reasons I couldn't.
So if I will finish English I am sure I will find hope and looking for more opportunities confidently. Six month later I am going to apply for Kazakhstan scholarship so I need to pass the interview. I will be able to apply for UN and other organizations since this is kind ofy dream to work at this kind of organization. I will be able to start AI in YouTube from foreigner. More importantly I will proud of myself that I finish English and I will find confidant to apply for good opportunities.
I want to find my hope again and I hope this program help me to I will come true my dream. I don't want to lose any other opportunities believe me i am a hardworking girl just I have losty way and my hope.
Once again I would like to say if I finish English this time successfully I will come true all my dreams. I ask you to help me to find my way, at this moment I don't know what to do and how to find myself.
So I hope this program help me to come true all my dreams and find myself once again. I need others help to find my own way."`,
  },
  {
    score: '8',
    label: 'English Level 8',
    text: `My name is Sairah, and I live in Herat province. I was a medical student, but after the Taliban regime came , I could not continue my lessons, Due to the challenges the  girls face in Afghanistan ,  I am unable to continue my education. Even if I try to study online, I often face internet problems.

If I am able to improve my English speaking skills, it will  help me and i can open many doors to me and my family . English is an international language, and as you know it  will help me to apply for international scholarships and study at universities in other countries. Right now, I am facing lot of challenges to continue my education, in our  country. But I believe that learning English will give me the opportunity to change my future.

With strong English skills, I can take online courses and  connect with people from around the world, and access better learning resources. It will also help me to  find better jobs and support myself and my family. 

If I am able to learn English , I will not only improve my own future, but I will also can help other students. I want to support students who face the same challenges I have, especially those who want to continue their higher education in other countries.
By learning English well, I can teach and guide others, share them  useful information about scholarships and applications, and help them how to how to study abroad. Many talented students don’t have access to good resources or support, and I want help them in this field .

My father is  a role model for. Even with many challenges, he was able to become a good doctor. I admire his hard work and dedication, and I also want to become a good doctor like him.

Unfortunately, because of the current situation in Afghanistan, it is not possible for me to continue my medical education in our country, and That is why I want to learn English. If I can speak English well, I will have the chance to study in another country where I can follow my dreams and become a doctor.`,
  },
  {
    score: '9',
    label: 'English Level 9',
    text: `My father was a professional engineer who built houses for people so that we could earn enough to support our lives. After some years, his bosses wanted him to make plans for houses in the computer and explain all the parts of the building in English to the project managers. Since he was not educated and more importantly “didn’t know English”, it was difficult for him to find job and this was one of the most important challenges he was faced during his career. That’s why I was sent to English centers since childhood, he didn’t want me to be like him. My father was always appreciating me to learn English and do my best. I started learning English language since I was a child and continued it consistently till now. I love speaking English, watching English movies, communicating with foreign people, more important than everything else I love understanding a new language because I feel like I can have a new citizenship, culture, and group of friends. I want to continue learning this language and take TOEFL test, Duolingo test, and do my best to be an expert in English language. I hope I can do it.`,
  },
];

const FITNESS_CRITERIA_RUBRIC = [
  {
    id: 'instructionFollowing',
    title: 'Instruction Following',
    tiers: [
      {
        score: '10',
        label: 'Highest',
        text: 'The student has correctly understood and followed instructions from the prompts',
      },
      {
        score: '5',
        label: 'Adequate',
        text: 'There is some misunderstanding of the instructions or prompts.',
      },
      {
        score: '1',
        label: 'Low',
        text: 'The student has not understood or followed the instructions, or does not discuss the prompt.',
      },
    ],
  },
  {
    id: 'originalThinking',
    title: 'Independent / Original Thinking',
    tiers: [
      {
        score: '10',
        label: 'Highest',
        text: 'The student shows evidence of original thinking— going beyond clichés or basic facts in a way that makes their essay stand out as different.',
      },
      {
        score: '5',
        label: 'Adequate',
        text: 'The student shows some evidence of original thinking.',
      },
      {
        score: '1',
        label: 'Low',
        text: "The student's ideas are very basic or clichéd. You've heard this a lot before.",
      },
    ],
  },
  {
    id: 'character',
    title: 'Demonstration of Character',
    tiers: [
      {
        score: '10',
        label: 'Highest',
        text: 'You want this applicant in AESOP— there is clear evidence of a strong personal character that would add to the community.',
      },
      {
        score: '5',
        label: 'Adequate',
        text: 'There is some evidence of a strong personal character. They might add something to the community.',
      },
      {
        score: '1',
        label: 'Low',
        text: 'There is no real evidence of a strong personal character. You don’t feel that this person would add anything to the AESOP community.',
      },
    ],
  },
];

/** @type {Array<{ band: string, criteria: string[], text: string }>} */
const EXEMPLAR_ESSAYS = [
  {
    band: '25–30',
    criteria: [
      'Follows Instructions: 10 (Addresses on prompt)',
      'Independent/Original Thinking: 8–10 (Tells a unique and original story)',
      'Demonstration of Character: 8–10 (Discusses social issues or values in a way that demonstrates personal character/value for the AESOP community)',
    ],
    text: `I am 8 years old. It is 6 o'clock in the evening. There is a nock on the door. My mom opens the door, it is my father. My siblings and I rush towards our father to say hi and do the ritual. The Ritual?
 Yes, the ritual is that my elder sister would kiss either the left or the right pocket of my father's coat in the morning and when he come back from the work he would get a chocolate bar in that pocket for all of us to eat.
 After getting changed my father calls us " Let's Halal (Slaughter) the chocolate bar", and one of us go to get the knife. My father cuts that ONE chocolate bar in small and equal pieces for all of us to eat. And we eat it all together with smiles and laughter, enjoying every bite of it.

 Buying one chocolate does not mean he couldn't afford to buy each of us one chocolate but it was a way to teach us the most important things in our lives.

 He was teaching us the importance of sharing, equality, gratitude, the concept of eating healthy in small portions but regularly, and most importantly the importance of family and the role of the leader of the family.

 Today, I am 22 years old and I have hundreds of this kind of stories which is impacted my every day live. That's why my father is my role model and the most INFLUENTIAL person in my life.

I am Zahra an Afghan girl and the one who wats to promote.The person who had many effect in my life is Fedor Dastivsky . He wada very famouse and powerful writer and his sayings are the things that motivates me . I always follow the books and the Stories that he wrote. I think that he was someone who understood the meaning of life. Though I don't want to become a writer ,this is my wish to become a Lawyer and to help the people but just I am amazed by his opinions an I am the follower of his way and opinions . I know that he had died in 1881, 19th centry but I think that still now he has many effects in many lifes of the people including me. I really can understand him the things that he tried to tell to people but in that time the Russia had the worest possible situation and the people couldn't know that there was such aperson that could tell them about the real life I mean the real meaning of the life . I am proud that such human were in this world and I know that there are some people like him that can understand the real meaning of life . I am so happy that I understood and known about him. Just I have a saying that Russia must be proud that such person was living there. thanks alote.`,
  },
  {
    band: '20–25',
    criteria: [
      'Follows Instructions: 8–10',
      'Independent/Original Thinking: 6–8',
      'Demonstration of Character: 6–8',
    ],
    text: `My name is Fatima a dream girl from Herat Afghanistan that always try to continue her education, I got married with an old man when I was child and he didn't let me to continue my education he use drugs. but I countuue my education at his force and got my High School certificate after I pass Kankor I enroll at management in Herat University. After one year all university closed and my father died and I got a divorce because of my education and dream and because of his drugs. Now I want to continue my education and i need English to learn to got an scholarship. this is a small story of me that I faced in the way of education and most of problems that now an alone girl have. "No one can imagine the challenges a widowed woman faces in a country like Afghanistan except herself. My continuing education depends on learning English.

A story that I fell it could summarize my character:
 I am a hard worker girl!
 I mean; you are completely know the Afghanistan situation right,
 In that difficult situation I just told myself to be strong and don’t give-up I am just 16 years old and since 2021 when Taliban came in Afghanistan and close the door of everything and everywhere I was so depressed by.
 And after a long time after reading a lot of motivational books and watch out a lot of youteob and I get better step by step and after that I started self study.
 That was an absolutely hard challenge because I didn’t have any future I didn’t have any thing for being strong! There was no reason for continue but I was make myself to must to be strong and keep going because after a lot of hardest and darkest night there will be a sunny day. And I started to learn new languages such us: Korean and Italian until I became fluent in. And across to them I was already study my school lessons by myself. Maybe you don’t know but in 2021 in the first months there was no online programs for us but a channel in TV was teaching the Math, Biology, physics and chemistry and I completely remember that was start at 7 am and I was just a 12 year old girl I remember I always woke up at 6:30 o’clock and wait for the channel program to learn my lessons. That was too hard but I just keep learning and right now I am fluent in two languages and know I would like to learn English as well.
 So that’s why I just describe myself with word HARD WORKER because that was a torible and difficult situation.`,
  },
  {
    band: '15–20',
    criteria: [],
    text: `I want to tell you about a story.
I am an Afghan girl. during the school I had a lot of dreams I always think about becoming a doctor in the future it was my big dream. when I graduated from school I participated in the Kankor exam in Afghanistan. I got 320 points out of 360.and I successed in one of the government university in Medical faculty in Balkh provence. I thought I reached to my dream I went to university for two years but unfortunately my country Afghanistan fall hands of the Taliban and we couldn't continue our education. after that I came to Iran for my education now I am a student in English Translation Major in Iran university. I am in second semester. I want to improve my english and one day I become a useful person in the society. I an alone in here. my family are in Afghanistan.
I want to help Afghan girls that they can't go to school.its my big dream in the future.now I can't help them because I am a student and I need to help.I want to make school and course for them.and I want to support them that they can learn and make our country.help to Afghan girls is my big ambition . I want to learn and teach for others.I want to encourage families that they let their girls that they should go to school go to course that they make their future and their family future and make the best future for Afghanistan.I want to support all of girls that they should learn because just by learning and trying we can reach to our goal and we should always try and learn that reach and make our future also make our country.
 It's my big dream that I want to do for Afghan girls.`,
  },
  {
    band: '10–15',
    criteria: [],
    text: `I am very interested in studies and education. When the Taliban came, they closed the doors of universities.Girls were not allowed to go to school and I was very upset. First of all, I would like to thank AESOP School for providing such a good opportunity for students, because English is an international language and most scholarships require English. I want to improve my English and pass the TOEFL test successfully. And in order to be able to succeed in foreign scholarships, the main goal is to improve my English level. AESOP School is a high-level school with good, hard-working teachers and an excellent teaching method. Also, the English book that this school teaches is a good and useful book.`,
  },
  {
    band: '5–10',
    criteria: [],
    text: `A.l got the first number in a physic competition but my best friend wished it so l gave her my medal forever.
 B.l will get my TOFEL test as well l travel to U.K and continue my school there.
 C.l couldn’t help any of the afghan students yet but if l could have the chance l would help them travel abroad by their intelligence and improve their skills.
 D.one of my uncles addicted to drugs along time ago just because of overthinking and having less confidence and staying away of relationships with people around him so l will never be a person who overthinks and has less confidence for stay a positive person in the world.`,
  },
];

const PRACTICE_ESSAYS = [
  {
    id: '1',
    text: `I would like to describe myself with ( intellectual)
I am a hard worker girl , as you know the hardest situation of Afghanistan it is so difficult to continue our lessons but since Taliban came in Afghanistan I started the self study.
And before I tried to apply for madical school of university.
As you know it needs an upper degree to get the chance of application for.
And as I told you before I started the self study and that was definitely difficult
But I worked hard and keep learning until I could found out the WOMAN ONLINE UNIVERSITY.
And I applied for medical school and they told as before joining the class you must to pass an exam. And you now we have to get a greatest score, and I was tried absolutely hard and finally the exam day has arrived. And I was stressful
because the exam was so hard and I studied a lot and watched out a lot of YT videos and asked for assist of AI before and I passed the exam . And finally thr day of results is arrived and I was like OMG I know that I won't be accepte but I just told myself to check the sheet, I when I take a look on I between 300 students they just accept 80 students I was one of them! I really shocked! Like oMG is it me? And after that I get a really good motivation and that's why I can describe myself with the word intellectual.
Sorry for any mistake.`,
  },
  {
    id: '2a',
    text: `my name is Talia and I am 15 year old I live in a small city in Badakhshan I have many friend in my school One day my classmate was very sad because she no understand math she always feel bad when teacher ask her question. I say her dont worry I help you I go to her home and we doing study together she is try hard and now she can do math very good I feel very happy because I help her she also is happy and now she help other students too I think help people is very good thing I want be a teacher in future and help more girls in my city for learn and become strong`,
  },
  {
    id: '3',
    text: `One day I found a lost dog I gave it water and food The dog was happy I felt happy too This shows I am kind`,
  },
  {
    id: '4',
    text: `When I learn language English, I will succee in the scholarship. It is very important for me that accept in the scholarship because I want to become a great doctor in the future.
I want serves myself, my family and my society.
A significant and influential person in my life has been my grandfather.  
He was a hardworking, dedicated, wise and motivated individual who was always eager to learn.`,
  },
  {
    id: '5',
    text: `Life is so tiring. It's not school, it's not courses. We girls are still trying, but how long will it take? When will we get what we deserve?`,
  },
];

const PRACTICE_SCORE_NOTES = [
  {
    id: '1',
    englishLevel: '7–8',
    englishNote:
      'While there are a lot of mistakes here, the use of English is quite complex. The applicant is using passive verbs and modal verbs as well as colloquialisms (“Like OMG is it me?”). It’s not surprising to me that this is someone who learns English from YouTube.',
    instructionFollowing: '10 — Responds to the prompt.',
    originalThinking:
      '8 — This applicant has a distinct, original voice. While the content of her essay is not that unique, the way that she tells her story gives a strong sense of her as a thinker.',
    character:
      '5 — I do get a sense that this is someone who works hard, but I don’t feel a strong sense of this applicant’s personal character beyond this.',
  },
  {
    id: '2',
    englishLevel: '4',
    englishNote:
      'Very simple sentences, mostly in the present tense in spite of relating a past event. The applicant is clearly stretching the limits of her English to tell this story.',
    instructionFollowing: '10 — Responds to a prompt',
    originalThinking:
      '6 — It’s difficult to judge this level of English, but there’s not much evidence of original thinking here.',
    character:
      '10 — There’s a strong demonstration of personal character here: someone who attaches great importance to helping her classmates and who is able to reflect on a particular time when doing so brought her happiness.',
  },
  {
    id: '3',
    englishLevel: '3',
    englishNote: 'This is the most simple, basic level of English communication.',
    instructionFollowing: '10 — Responds to the prompt— this is a story that tells us about the applicant.',
    originalThinking:
      '8 — I would actually rate this quite high on original thinking, because it’s not the type of story we hear very often. It’s not cliched!',
    character:
      '8 — Maybe it’s because I’m a dog lover, but I think this shows a good character. The applicant is not just telling the story, also— they’re reflecting on its meaning.',
  },
  {
    id: '4',
    englishLevel: '5',
    englishNote:
      'While the English is basic with many errors, the applicant is successfully using multiple verb tenses.',
    instructionFollowing: '5 — The applicant appears to be responding to multiple essay prompts.',
    originalThinking: '2 — I don’t see much here that is original…',
    character:
      '2 — There’s simply not enough here to judge the applicant’s character with, in part because they’re trying to answer multiple essay prompts.',
  },
  {
    id: '5',
    englishLevel: '9',
    englishNote: 'There’s not much to judge, but it seems quite advanced.',
    instructionFollowing: '2 — Doesn’t respond to any of the prompts.',
    originalThinking:
      '8 — I’m not totally sure what this person means by “it’s not school, it’s not courses,” but they seem to be expressing (aggressively) a pretty strong complaint. It’s a very original and forceful statement. Now: some people might score this much lower. However, I’m interested.',
    character:
      '7 — I also feel like I really want this person in my AESOP class. I’m interested that they’re making a demand: when will women get what they deserve? I would like to talk to this person.',
  },
];

const REVIEW_INSTRUCTIONS = {
  title: '2026–2027 Rubric for Applications',
};

module.exports = {
  REVIEW_INSTRUCTIONS,
  ENGLISH_LEVEL_RUBRIC,
  parseEnglishLevelRubricText,
  englishLevelDetailToLines,
  AI_WARNING_SIGNS,
  AI_ESSAY_EXAMPLES,
  TRAINING_ESSAY_EXAMPLES,
  FITNESS_CRITERIA_RUBRIC,
  EXEMPLAR_ESSAYS,
  PRACTICE_ESSAYS,
  PRACTICE_SCORE_NOTES,
};
