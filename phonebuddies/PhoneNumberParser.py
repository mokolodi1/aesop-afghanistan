# 

import re
import phonenumbers
from phonenumbers.phonenumberutil import NumberParseException

# Static methods to convert strings into E.164 formatted
# numbers.
# Won't work for all strings, but it works for
# all the test cases in test_PhoneNumberParser.py 
class PhoneNumberParser:
    def __init__(self):
        self.cache = {}  # TODO: Implement caching

    @staticmethod
    def add_plus_sign(number):
        if not number.startswith('+'):
            number = '+' + number
            print(f'Prepended plus sign to {number}')
        return number

    @staticmethod
    def format_afghan_number(number):
        if len(number) == 13 and number.startswith('+93'):
            print('Length = 13 Afghan country code case')
            return number
        elif len(number) == 10 and number.startswith(('+740', '+760')):
            print('Length = 10 Afghan no country code case')
            return '+93' + number[1:]

    @staticmethod
    def parse_and_format(number):
        number = PhoneNumberParser.add_plus_sign(number)
        print(f'Length of number is {len(number)}')

        afghan_number = PhoneNumberParser.format_afghan_number(number)
        if afghan_number:
            return afghan_number

        print('Else case for non-Afghan numbers')
        parsed_number = phonenumbers.parse(number, None)
        print(f"Correctly parsed this number:\n{number}")
        return phonenumbers.format_number(parsed_number, phonenumbers.PhoneNumberFormat.E164)

    @staticmethod
    def can_parse_and_format(number):
        """
        Returns True or False of whether or not parse_and_format will throw an exception
        """
        try:
            phonenumbers.parse('+' + number)
            return True
        except NumberParseException:
            return False

    @staticmethod
    def parse_by_hand(number, buddy_type=None):
        print('Started parsing by hand')

        number = re.sub(r'^00', '', number)
        print('Removed leading zeros' if number.startswith('00') else '')

        if len(number) == 12 and number.startswith('92'):
            print('Parsing by hand length 12 Pakistan case')
            if PhoneNumberParser.can_parse_and_format(number):
                return PhoneNumberParser.parse_and_format(number)

        if len(number) == 11 and number.startswith('93'):
            print('Parsing by hand length 11 Afghan case')
            if PhoneNumberParser.can_parse_and_format(number):
                return PhoneNumberParser.parse_and_format(number)

        if len(number) == 9 and number.startswith(('760', '740')):
            print('Parsing by hand length 9 Afghan case')
            checking = '93' + number
            print('Prepended 93 since starts with 760 or 740')
            if PhoneNumberParser.can_parse_and_format(checking):
                return PhoneNumberParser.parse_and_format(checking)

        if len(number) == 10:
            if not number.startswith(('1', '44', '93')):
                checking = '1' + number
                print('Prepended 1 since assume US without country code')
                if PhoneNumberParser.can_parse_and_format(checking):
                    return PhoneNumberParser.parse_and_format(checking)

        if len(number) == 9:
            if buddy_type == "Afghan" and not number.startswith('93'):
                checking = '93' + number
                print('Prepended 93 since buddy_type is Afghan')
                if PhoneNumberParser.can_parse_and_format(checking):
                    return PhoneNumberParser.parse_and_format(checking)

        print('Default parsing by hand case')
        return 'Failed, even after attempt to parse by hand'

    @staticmethod
    def parse_to_valid_whatsapp(number, buddy_type=None):
        number = re.sub(r'[\s\D]', '', number)
        print(f"{number} was obtained after removing whitespace and non-digit chars")

        if len(number) == 10 and number[0] != '1':
            number = '1' + number

        if PhoneNumberParser.can_parse_and_format(number):
            print(f"{number} parsed by phonenumber.parse")
            return PhoneNumberParser.parse_and_format(number)
        else:
            print(f"{number} Couldn't parse after removing non-digit chars")
            return PhoneNumberParser.parse_by_hand(number, buddy_type)

# Example usage
print(PhoneNumberParser.parse_to_valid_whatsapp('00923070000000 whatsapp number '))
print('+923070000000')