import logging
import re
from phonebuddies.ResultTracker import ResultTracker
import phonenumbers


class PhoneNumberParser:
    """
    Static methods to convert strings into E.164 formatted numbers.
    Won't work for all strings, but it works for all the test cases in test_PhoneNumberParser.py 
    """


    def setUp(self):
        # Hide warning logs when running these tests
        logging.getLogger().setLevel(logging.ERROR)


    @staticmethod
    def parse_and_format(number):
        if not number.startswith('+'):
            number = '+' + number

        parsed_number = phonenumbers.parse(number, None)
        return phonenumbers.format_number(parsed_number, phonenumbers.PhoneNumberFormat.E164)


    @staticmethod
    def can_parse_and_format(number):
        """
        Returns True or False of whether or not parse_and_format will throw an exception
        """
        try:
            phonenumbers.parse('+' + number)
            return True
        except phonenumbers.phonenumberutil.NumberParseException:
            return False


    @staticmethod
    def parse_to_valid_whatsapp(original_number_text, buddy_type=None):
        if original_number_text is None:
            return None

        # Remove whitespace and non-digit characters
        only_numbers = re.sub(r'[\s\D]', '', original_number_text)

        # Remove any leading zeros if present
        number = re.sub(r'^0+', '', only_numbers)

        # Prepended with 93 if it starts with 760 or 740 - looks Afghan
        # Assumption: we won't have English volunteers with an Afghan WhatsApp
        if len(number) == 9 and number.startswith(('760', '740')) and buddy_type != "English":
            checking = '93' + number
            if PhoneNumberParser.can_parse_and_format(checking):
                return PhoneNumberParser.parse_and_format(checking)

        # Americans tend to not put in their country code,
        # and so far we haven't encountered any user-entered numbers that are 10-digits
        # and missing a + at the beginning.
        if len(number) == 10 and not number.startswith(('1')) and original_number_text[0] != "+":
            checking = '1' + number
            if PhoneNumberParser.can_parse_and_format(checking):
                return PhoneNumberParser.parse_and_format(checking)

        # If Afghan-esque and type is Afghan, try with 93
        if len(number) == 9 and buddy_type == "Afghan" and not number.startswith('93'):
                checking = '93' + number
                if PhoneNumberParser.can_parse_and_format(checking):
                    return PhoneNumberParser.parse_and_format(checking)

        # Try and see if we can parse the number without any changes
        if PhoneNumberParser.can_parse_and_format(number):
            return PhoneNumberParser.parse_and_format(number)

        ResultTracker.add_issue("Failed to parse number to valid WhatsApp: %s" % original_number_text)

        return None


    @staticmethod
    def _prep_phone_for_similar_comparison(number):
        # Remove non-number characters
        number = re.sub(r'[\s\D]', '', number)

        # Remove any leading zeros if present
        number = re.sub(r'^0+', '', number)

        return number


    @staticmethod
    def numbers_are_similar(first, second):
        """
        Return a boolean of whether the first and second numbers are similar enough
        """
        if first is None or second is None:
            return False

        return PhoneNumberParser._prep_phone_for_similar_comparison(first) == PhoneNumberParser._prep_phone_for_similar_comparison(second)
