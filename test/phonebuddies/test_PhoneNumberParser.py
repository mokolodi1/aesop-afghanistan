import unittest
from phonebuddies.PhoneNumberParser import PhoneNumberParser


class TestPhoneNumberParser(unittest.TestCase):


    def test_asian_68_p66s800000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+66 800000000'), '+66800000000')

    def test_asian_68_p86s136d1000d0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+86 136-1000-0000'), '+8613610000000')

    def test_asian_68_p86s13820000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+86 13820000000'), '+8613820000000')

    def test_asian_68_p8801400000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+8801400000000'), '+8801400000000')

    # def test_asian_68_p8s902s000s0000(self):
        # TODO: figure out what the number should actually be for this person lol
        # self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+8 902 000 0000'), '+89020000000')

    def test_europe_p33s6s10s00s00s00(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+33 6 10 00 00 00'), '+33610000000')

    def test_europe_p351930000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+351930000000'), '+351930000000')

    def test_europe_invisible_char___III__p353s_89_s000s0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('‭+353 (89) 000 0000'), '+353890000000')

    def test_europe_p44s7900s000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+44 7900 000000'), '+447900000000')

    def test_me_9_p905550000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+905550000000'), '+905550000000')

    def test_me_9_p917070000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+917070000000'), '+917070000000')

    def test_me_9_p91s9540000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+91 9540000000'), '+919540000000')

    def test_me_9_00923070000000swhatsappsnumbers(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('00923070000000 whatsapp number '), '+923070000000')

    def test_me_9_p92s312s0000000s_whatsapp_(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+92 312 0000000 (whatsapp)'), '+923120000000')

    def test_me_9_p92s315s000s0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+92 315 000 0000'), '+923150000000')

    def test_me_9_p92d31d900d00000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+92-31-900-00000'), '+923190000000')

    def test_me_9_p923200000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+923200000000'), '+923200000000')

    def test_me_9_p93_0_700000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+93(0)700000000'), '+930700000000')

    def test_me_9_p930740000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+930740000000'), '+930740000000')

    def test_me_9_93720000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('93720000000'), '+93720000000')

    def test_me_9_p93s740s000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+93 740 000000'), '+93740000000')

    def test_me_9_p_93_770000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+(93)770000000'), '+93770000000')

    def test_me_9_p93s77s000s0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+93 77 000 0000'), '+93770000000')

    def test_me_9_p93s770000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+93 770000000'), '+93770000000')

    def test_me_9_p93d77d000d0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+93-77-000-0000'), '+93770000000')

    def test_me_9_0093780000000swhatsAap(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('0093780000000 whatsAap'), '+93780000000')

    def test_me_9_93790000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('93790000000'), '+93790000000')

    def test_me_9_p968s7000s0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+968 7000 0000'), '+96870000000')

    def test_me_9__p973_30000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('(+973)30000000'), '+97330000000')

    def test_me_9_p974s30000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+974 30000000'), '+97430000000')

    #def test_no_country_p201s000s0000(self):
        # TODO: figure out what the number should actually be for this person lol
        #self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+201 000 0000'), '+12010000000')

    def test_no_country_267d000d0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('267-000-0000'), '+12670000000')

    def test_no_country_4150000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('4150000000'), '+14150000000')

    def test_no_country_6090000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('6090000000'), '+16090000000')

    def test_no_country_617d000d0000s_USAscode_(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('617-000-0000 (USA code)'), '+16170000000')

    def test_no_country_740000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('740000000'), '+93740000000')

    def test_no_country_93760000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('93760000000'), '+93760000000')

    def test_no_country_760000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('760000000'), '+93760000000')

    def test_us_1s_207_s000d0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('1 (207) 000-0000'), '+12070000000')

    def test_us_s1s_215_s000s0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('*1 (215) 000 0000'), '+12150000000')

    def test_us_p1s_215_s000d0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+1 (215) 000-0000'), '+12150000000')

    def test_us_p1s215s000d0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+1 215 000-0000'), '+12150000000')

    def test_us_p1s215s000s0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+1 215 000 0000'), '+12150000000')

    def test_us_p1s415d000d0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+1 415-000-0000'), '+14150000000')

    def test_us_p1s508s0000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+1 508 0000000'), '+15080000000')

    def test_us_p1s_609_d000d0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+1 (609)-000-0000'), '+16090000000')

    def test_us_p1s6090000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+1 6090000000'), '+16090000000')

    def test_us_p1_613_000d0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+1(613)000-0000'), '+16130000000')

    def test_us_p1s_646_000d0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+1 (646)000-0000'), '+16460000000')

    def test_us_p1s714s000s0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+1 714 000 0000'), '+17140000000')

    def test_us_p17320000000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+17320000000'), '+17320000000')

    def test_us_ps1s_917_s000d0000(self):
        self.assertEqual(PhoneNumberParser.parse_to_valid_whatsapp('+ 1 (917) 000-0000'), '+19170000000')


if __name__ == '__main__':
    unittest.main()