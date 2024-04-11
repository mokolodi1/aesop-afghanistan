import re
import phonenumbers
from phonenumbers.phonenumberutil import NumberParseException

class PhoneNumberParser:

    # TODO: cache this stuff
    @staticmethod
    def parse_and_format(number):
        # Add a plus sign if there's not one at the beginning
        if number[0] != "+":
            number = "+" + number
        print('prepended plus sign to ' + number)
        parsed_number = phonenumbers.parse(number, None)
        print("Correctly parsed!")
        return phonenumbers.format_number(parsed_number, phonenumbers.PhoneNumberFormat.E164)

    @staticmethod
    def can_parse_and_format(number):
        """
        Returns True or False of whether or not parse_and_format will throw an exception
        """
        try:
            phonenumbers.parse('+' + number)
            return True
        except NumberParseException as e:
            return False

    @staticmethod
    def start_parsing_by_hand(number, buddy_type=None):
        print('started parsing by hand')

        if number.startswith('00'):
            number = number[2:]
            print('removed leading zeros')

        # First check for Afghan numbers without area codes
        if len(number) == 9 and number.startswith(('760', '740')):
                checking = '93' + number
                print('prepended 93 since starts with 760 or 740')
                if PhoneNumberParser.can_parse_and_format(checking):
                    return PhoneNumberParser.parse_and_format(checking)

        # Assume some 10-digit numbers are American
        elif len(number) == 10:
            if not number.startswith(('1', '44', '93')):
                checking = '1' + number
                print('prepended 1 since assume US without country code')
                if PhoneNumberParser.can_parse_and_format(checking):
                    return PhoneNumberParser.parse_and_format(checking)
        

        elif len(number) == 9:
            if buddy_type == "Afghan" and not number.startswith('93'):
                checking = '93' + number
                print('prepended 93 since buddy_type is Afghan')
                if PhoneNumberParser.can_parse_and_format(checking):
                    return PhoneNumberParser.parse_and_format(checking)

        return 'Failed, even after attempt to parse by hand'

    @staticmethod
    def parse_to_valid_whatsapp(number, buddy_type=None):
        number = re.sub(r'[\s\D]', '', number)
        print(number, 'was obtained after removing whitespace and non-digit chars')
        
        if PhoneNumberParser.can_parse_and_format(number):
            print(number, ' parsed by phonenumber.parse')
            return PhoneNumberParser.parse_and_format(number)

        else:
            print(number + ' Couldn\'t parse after removing non-digit chars')
            return PhoneNumberParser.start_parsing_by_hand(number, buddy_type)

# Call the function with the provided input
print(PhoneNumberParser.parse_to_valid_whatsapp('617-000-0000 (USA code)'))

# Case where phonenumbers.parse says a phone number is already parsed
# but it actually needs an area code
# num = phonenumbers.parse ('+760000000', 'None')
# print (phonenumbers.format_number(num, phonenumbers.PhoneNumberFormat.E164))

# Case where phonenumbers.parses a phone number wrong
num = phonenumbers.parse ('+617-000-0000')
print (phonenumbers.format_number(num, phonenumbers.PhoneNumberFormat.E164))