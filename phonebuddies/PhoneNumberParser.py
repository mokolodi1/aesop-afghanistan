import re
import phonenumbers
from phonenumbers.phonenumberutil import NumberParseException

class PhoneNumberParser:

    # TODO: cache this stuff
    @staticmethod
    def parse_and_format(number):
        """
        Parses with phonenumbers and returns the formatted result.

        Takes numbers with or without a + at the beginning (required at the beginning for phonenumbers.parse)
        """
        # Add a plus sign if there's not one at the beginning
        if number[0] != "+":
            number = "+" + number

        parsed_number = phonenumbers.parse(number, None)
        print("Correctly parsed!")
        return phonenumbers.format_number(parsed_number, phonenumbers.PhoneNumberFormat.E164)


    @staticmethod
    def can_parse_and_format(number):
        """
        Returns True or False of whether or not parse_and_format will throw an exception
        """

        try: 
            PhoneNumberParser.parse_and_format(number)
            return True
        except NumberParseException as e:
            return False
        
    
    # @staticmethod
    # def matches_type_or_is_none(buddy_type, match_against):
    #     """
    #     Allows comparison of buddy type whether or not that info is passed in.
        
    #     If the buddy_type is None, assume it matches the comparison.
    #     Otherwise actually check them against one another.
    #     """
    #     if buddy_type is None:
    #         return True

    #     return buddy_type == match_against



    # Called by parse_to_valid_whatsapp when it doesn't work at
    # first. parse_to_valid_whatsapp has already removed any
    # non-digit characters.
    @staticmethod
    def start_parsing_by_hand(difficult_string, buddy_type=None):
        print ('started parsing by hand')

        # Remove 00 if the number starts with that (will be replaced by + in parse_and_format)
        if difficult_string.startswith('00'):
            difficult_string = difficult_string[2:]
        
        # For each of these different special cases, we'll make sure that several different criteria match before
        # attempting to return a re-parsed phone number with assumptions baked in.
        # Start with the most specific checks and end with the least specific checks in order to provide the best balance of
        # accuracy and success in finding a reasonable valid number.

        # Special cases for Afghan numbers without country codes
        # if country_code_is_missing(number) and [TODO: length is correct for Afghan number w/o country code]
            # fix the string and send it off to be parsed
        if len(difficult_string) == 9:
            if difficult_string.startswith('760') or difficult_string.string.startswith('740'):
                checking = '93' + difficult_string
                if PhoneNumberParser.can_parse_and_format(checking):
                    return PhoneNumberParser.parse_and_format(checking)


        if len(difficult_string) == 10:
            if not difficult_string.startswith(('1', '44', '93')):
                difficult_string = 1 + difficult_string

                return PhoneNumberParser.parse_and_format(difficult_string)


        # Assume Afghan buddies have Afghan country codes
        if buddy_type == "Afghan" and not difficult_string.startswith('93'):
            checking = '93' + difficult_string
            return PhoneNumberParser.parse_and_format(checking)

        
        # Least specific

        return 'Failed, even after attempt to parse by hand'


    @staticmethod
    def parse_to_valid_whatsapp(unparsed_number, buddy_type=None):
        
        # Use phonenumbers package on raw input if possible
        if PhoneNumberParser.can_parse_and_format(unparsed_number):
            return PhoneNumberParser.parse_and_format(unparsed_number)
        
        print(unparsed_number, 'failed first parse')
        # Remove all characters that are not a digit (including removing whitespace)
        digits_only = re.sub(r'[\s\D]', '', unparsed_number)
        if PhoneNumberParser.can_parse_and_format(digits_only):
            print('Parsed after removing non-digit chars')
            return PhoneNumberParser.parse_and_format(digits_only)

        print(digits_only + 'Couldnt parse after removing non-digit chars')
        return PhoneNumberParser.start_parsing_by_hand(digits_only, buddy_type)


print(PhoneNumberParser.parse_to_valid_whatsapp('+89020000000', 'None'))


'''
        print (phone_number)
        # Remove any non-digit characters from the phone number with regex

        print(digits_only)

        # Special cases for Afghan numbers without country codes
        if digits_only.startswith('760'):
            return '+93' + digits_only
        elif digits_only.startswith('740'):
            return '+93' + digits_only

        # If the phone number starts with '00', remove the leading '00'
        if digits_only.startswith('00'):
            digits_only = digits_only[2:]
        
        # Dictionary mapping country codes to their respective international dialing codes
        country_codes = {
            '1': '+1',  # United States
            '44': '+44',  # United Kingdom
            '93': '+93', # Afghanistan
            # Add more country codes as needed
        }

        # Iterate over country codes to find a match
        for code, dialing_code in country_codes.items():
            if digits_only.startswith(code):
                # Get the city code and local number
                city_code = digits_only[len(code):len(code) + 3]
                local_number = digits_only[len(code) + 3:]
                
                # Construct the full international format with leading zeros retained
                
                print(f'{dialing_code}{city_code}{local_number}'.strip())

                return f'{dialing_code}{city_code}{local_number}'.strip()  # Strip any whitespace



        ready_for_phonenumbers_module = '+' + digits_only
        return ready_for_phonenumbers_module
        parsed_number = phonenumbers.parse(ready_for_phonenumbers_module, 
None)
        return phonenumbers.format_number(parsed_number, phonenumbers.PhoneNumberFormat.E164) 
'''